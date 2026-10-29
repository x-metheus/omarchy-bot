import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { expect, test } from "bun:test";
import type { DeviceClientFrame, DeviceServerFrame } from "../../packages/protocol/src/index.ts";
import { sidecarCommand as command } from "./helpers/sidecarCommand.ts";

const DEVICE = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const windows = process.platform === "win32";

// Real Sidecar processes and filesystem readiness cannot advance with fake timers.
async function until(probe: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(20);
  }
}

async function startSidecar(always: string[] = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-process-"));
  writeFileSync(path.join(root, ".omarchy-bot-local-policy.json"), JSON.stringify({ always, never: [] }));
  const token = "scripted+paired/token?secret";
  const frames: DeviceClientFrame[] = [];
  let send: ((frame: DeviceServerFrame) => void) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname !== "/api/devices" || url.searchParams.get("access_token") !== token) return new Response(null, { status: 401 });
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, message) {
        const frame = JSON.parse(String(message)) as DeviceClientFrame;
        frames.push(frame);
        if (frame.type === "register") {
          send = (frame) => { ws.send(JSON.stringify(frame)); };
          ws.send(JSON.stringify({ type: "registered", deviceId: DEVICE }));
        }
      },
    },
  });
  const child: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(command, {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, OMARCHY_BOT_SERVICE_URL: `ws://127.0.0.1:${server.port}`, OMARCHY_BOT_DEVICE_ID: DEVICE, OMARCHY_BOT_DEVICE_TOKEN: token, OMARCHY_BOT_SIDECAR_ROOT: root },
  });
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const output = (async () => { for await (const chunk of child.stdout) stdout += decoder.decode(chunk, { stream: true }); })();
  const errors = (async () => { stderr = await new Response(child.stderr).text(); })();
  const close = async () => {
    try {
      await server.stop(true);
      await until(() => child.exitCode !== null, "Sidecar did not close after Service disconnect");
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await Promise.all([output, errors]);
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    await until(() => send !== undefined || child.exitCode !== null, "Sidecar never registered");
    if (!send) throw new Error(`Sidecar exited before registration: ${stderr}`);
  } catch (error) {
    await close();
    throw error;
  }
  return { root, child, frames, send, stdout: () => stdout, close };
}

test("production Sidecar authenticates, registers its shell, asks and returns output and exit code", async () => {
  const sidecar = await startSidecar();
  try {
    expect(sidecar.frames[0]).toMatchObject({ type: "register", deviceId: DEVICE, os: windows ? "windows" : process.platform === "darwin" ? "macos" : "linux", shell: windows ? "powershell-5.1" : "posix-sh", capabilities: ["shell", "search", "files", "transfer"] });
    const script = windows ? "Write-Output $PSVersionTable.PSVersion.ToString(); Write-Output 'process-smoke'; exit 7" : "printf process-smoke; exit 7";
    sidecar.send({ type: "local.job", jobId: "run", action: "run", hostname: "paired", botId: "bot", turnId: "turn", command: script });
    await until(() => sidecar.stdout().includes('"type":"ask"'), "Sidecar never asked for approval");
    sidecar.child.stdin.write(`${JSON.stringify({ type: "allow-once", jobId: "run" })}\n`);
    await until(() => sidecar.frames.some((frame) => frame.type === "local.result"), "Sidecar never returned command output");
    const result = sidecar.frames.find((frame) => frame.type === "local.result");
    expect(result).toMatchObject({ type: "local.result", jobId: "run", ok: true, exitCode: 7 });
    if (result?.type !== "local.result" || !result.ok) throw new Error("command failed");
    expect(result.text).toContain("process-smoke");
    if (windows) expect(result.text).toMatch(/^5\.1\./);
    await sidecar.close();
    expect(sidecar.child.exitCode).not.toBeNull();
  } finally {
    if (sidecar.child.exitCode === null) await sidecar.close();
  }
}, 25_000);

test.skipIf(!windows)("production Sidecar returns readable PowerShell warning and error text through the device channel", async () => {
  const sidecar = await startSidecar();
  try {
    sidecar.send({ type: "local.job", jobId: "streams", action: "run", hostname: "paired", botId: "bot", turnId: "turn", command: "Write-Warning 'warning <sentinel> & λ'; Write-Error 'error <sentinel> & λ'" });
    await until(() => sidecar.stdout().includes('"type":"ask"'), "Sidecar never asked for approval");
    sidecar.child.stdin.write(`${JSON.stringify({ type: "allow-once", jobId: "streams" })}\n`);
    await until(() => sidecar.frames.some((frame) => frame.type === "local.result" && frame.jobId === "streams"), "PowerShell diagnostics never returned");
    const result = sidecar.frames.find((frame) => frame.type === "local.result" && frame.jobId === "streams");
    expect(result).toMatchObject({ type: "local.result", jobId: "streams", ok: true, exitCode: 1 });
    if (result?.type !== "local.result" || !result.ok) throw new Error("PowerShell diagnostics failed");
    expect(result.text).toContain("warning <sentinel> & λ");
    expect(result.text).toContain("error <sentinel> & λ");
    expect(result.text).not.toContain("#< CLIXML");
    expect(result.text).not.toContain("<Objs");
    expect(result.text).not.toContain("_x000D_");
  } finally {
    await sidecar.close();
  }
}, 40_000);

test.skipIf(!windows)("production Sidecar returns clean remembered output and leaves a successfully launched application alive", async () => {
  const encoded = Buffer.from("$PID | Set-Content descendant.pid; while (!(Test-Path release)) { Start-Sleep -Milliseconds 20 }; Set-Content marker.txt survived", "utf16le").toString("base64");
  const script = `$PID | Set-Content root.pid; $p = Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -WorkingDirectory (Get-Location).Path -RedirectStandardOutput child.out -RedirectStandardError child.err -PassThru; $p.Id | Set-Content launched.pid; Write-Output 'remembered-launch'`;
  const sidecar = await startSidecar([`run:${script}`]);
  const files = ["root.pid", "descendant.pid", "launched.pid"];
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  try {
    sidecar.send({ type: "local.job", jobId: "launch", action: "run", hostname: "paired", botId: "bot", turnId: "turn", command: script });
    await until(() => files.every((file) => existsSync(path.join(sidecar.root, file)) && /^\d+$/.test(readFileSync(path.join(sidecar.root, file), "utf8").trim())), "PowerShell root and launched application never recorded their PIDs");
    const rootPid = Number(readFileSync(path.join(sidecar.root, "root.pid"), "utf8").trim());
    const descendantPid = Number(readFileSync(path.join(sidecar.root, "descendant.pid"), "utf8").trim());
    for (const pid of [rootPid, descendantPid]) expect(Number.isSafeInteger(pid) && pid > 0).toBeTrue();
    expect(Number(readFileSync(path.join(sidecar.root, "launched.pid"), "utf8").trim())).toBe(descendantPid);
    expect(alive(descendantPid)).toBeTrue();
    await until(() => !alive(rootPid), `PowerShell root ${rootPid} did not exit after launching application ${descendantPid}`);
    await until(() => sidecar.frames.some((frame) => frame.type === "local.result" && frame.jobId === "launch"), `PowerShell root ${rootPid} exited but command completion still waits on application ${descendantPid}`);
    const result = sidecar.frames.find((frame) => frame.type === "local.result" && frame.jobId === "launch");
    expect(result).toMatchObject({ type: "local.result", jobId: "launch", ok: true, exitCode: 0 });
    if (result?.type !== "local.result" || !result.ok) throw new Error("remembered launch failed");
    expect(result.text?.trim()).toBe("remembered-launch");
    expect(sidecar.stdout()).not.toContain('"type":"ask"');
    expect(alive(descendantPid)).toBeTrue();
    expect(existsSync(path.join(sidecar.root, "marker.txt"))).toBeFalse();
    writeFileSync(path.join(sidecar.root, "release"), "");
    await until(() => existsSync(path.join(sidecar.root, "marker.txt")) && readFileSync(path.join(sidecar.root, "marker.txt"), "utf8").trim() === "survived", "launched application did not survive normal command completion");
  } finally {
    sidecar.send({ type: "local.cancel", jobId: "launch" });
    // Discover children before awaiting shutdown: inherited capture handles can block completion.
    const pids = files.flatMap((file) => {
      const target = path.join(sidecar.root, file);
      const pid = existsSync(target) ? Number(readFileSync(target, "utf8").trim()) : NaN;
      return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
    });
    for (const pid of pids) {
      if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
    try {
      await until(() => pids.every((pid) => !alive(pid)), "launched application survived targeted cleanup");
    } finally {
      await sidecar.close();
    }
  }
}, 90_000);

test("production Sidecar exits and abandons a pending Ask when the app closes stdin", async () => {
  const sidecar = await startSidecar();
  try {
    sidecar.send({ type: "local.job", jobId: "stdin-eof", action: "write", hostname: "paired", botId: "bot", turnId: "turn", path: "orphan.txt", contents: "must not be written" });
    await until(() => sidecar.stdout().includes('"type":"ask"'), "Sidecar never asked for approval");

    sidecar.child.stdin.end();

    await until(() => sidecar.child.exitCode !== null, "Sidecar survived the app closing stdin");
    expect(await sidecar.child.exited).toBe(0);
    expect(sidecar.frames.some((frame) => frame.type === "local.result")).toBeFalse();
    expect(existsSync(path.join(sidecar.root, "orphan.txt"))).toBeFalse();
  } finally {
    await sidecar.close();
  }
}, 25_000);

test("production Sidecar refuses this OS's credential stores for every file action", async () => {
  const sidecar = await startSidecar();
  const stores = windows ? ["AppData/Local/Microsoft/Credentials", "AppData/Roaming/Microsoft/Protect", "AppData/Local/Microsoft/Vault", "AppData/Roaming/Microsoft/Crypto"]
    : process.platform === "darwin" ? ["Library/Keychains", "Library/Accounts", "Library/Application Support/com.apple.TCC"] : [".ssh", ".gnupg", ".aws", ".config"];
  try {
    for (const store of stores) {
      const file = `${store}/secret.txt`;
      mkdirSync(path.dirname(path.join(sidecar.root, file)), { recursive: true });
      writeFileSync(path.join(sidecar.root, file), "needle-secret");
      for (const action of ["read", "write", "search", "transfer-to", "transfer-from"] as const) {
        const jobId = `${store}:${action}`;
        sidecar.send({ type: "local.job", jobId, action: action === "transfer-to" || action === "transfer-from" ? "transfer" : action, hostname: "paired", botId: "bot", turnId: "turn", path: file, destination: `${store}/missing/new.txt`, direction: action === "transfer-from" ? "from-workspace" : "to-workspace", query: "needle", contents: "overwrite" });
        await until(() => sidecar.stdout().includes(JSON.stringify(jobId)), "credential Ask never arrived");
        sidecar.child.stdin.write(`${JSON.stringify({ type: "allow-once", jobId })}\n`);
        await until(() => sidecar.frames.some((frame) => frame.type === "local.result" && frame.jobId === jobId), "credential refusal never arrived");
        expect(sidecar.frames.find((frame) => frame.type === "local.result" && frame.jobId === jobId)).toMatchObject({ ok: false, error: "Local Sidecar refuses credential directories" });
      }
      expect(readFileSync(path.join(sidecar.root, file), "utf8")).toBe("needle-secret");
      expect(existsSync(path.join(sidecar.root, store, "missing"))).toBeFalse();
    }
  } finally {
    await sidecar.close();
  }
}, 30_000);

test("production Sidecar cancels a remembered job and its descendant on this OS", async () => {
  const encoded = Buffer.from("while (!(Test-Path release)) { Start-Sleep -Milliseconds 20 }; Set-Content marker.txt survived", "utf16le").toString("base64");
  const script = windows
    ? `$PID | Set-Content root.pid; $p = Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -NoNewWindow -PassThru; $p.Id | Set-Content descendant.pid; Start-Sleep -Seconds 60`
    : `echo $$ > root.pid; sh -c 'trap "" TERM; echo $$ > descendant.pid; while [ ! -f release ]; do sleep 0.05; done; printf survived > marker.txt' & wait`;
  const sidecar = await startSidecar([`run:${script}`]);
  const pids: number[] = [];
  const alive = (pid: number): boolean => {
    if (!windows) {
      // ps is available on Linux and macOS; kill(pid, 0) also reports zombies as alive.
      const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
      if (state.exitCode !== 0 && state.exitCode !== 1) throw new Error(state.stderr.toString());
      return state.stdout.toString().trim().length > 0 && !/^[ZX]/.test(state.stdout.toString().trim());
    }
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  try {
    sidecar.send({ type: "local.job", jobId: "cancel", action: "run", hostname: "paired", botId: "bot", turnId: "turn", command: script });
    await until(() => existsSync(path.join(sidecar.root, "descendant.pid")) && readFileSync(path.join(sidecar.root, "descendant.pid"), "utf8").trim().length > 0, "descendant never started");
    for (const file of ["root.pid", "descendant.pid"]) {
      const pid = Number(readFileSync(path.join(sidecar.root, file), "utf8").trim());
      expect(Number.isSafeInteger(pid) && pid > 0).toBeTrue();
      pids.push(pid);
      expect(alive(pid)).toBeTrue();
    }
    sidecar.send({ type: "local.cancel", jobId: "cancel" });
    await until(() => pids.every((pid) => !alive(pid)), "job tree survived local.cancel");
    writeFileSync(path.join(sidecar.root, "release"), "");
    expect(existsSync(path.join(sidecar.root, "marker.txt"))).toBeFalse();
    expect(sidecar.frames.some((frame) => frame.type === "local.result" && frame.jobId === "cancel")).toBeFalse();
  } finally {
    sidecar.send({ type: "local.cancel", jobId: "cancel" });
    try { await sidecar.close(); } finally {
      for (const pid of pids) { if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } }
    }
  }
}, 30_000);

test("production Sidecar enforces TLS trust and pairing before an approved wss command", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-process-tls-"));
  try {
    const ca = path.join(root, "ca.pem");
    const caKey = path.join(root, "ca-key.pem");
    const cert = path.join(root, "cert.pem");
    const key = path.join(root, "key.pem");
    const csr = path.join(root, "server.csr");
    const extensions = path.join(root, "extensions.cnf");
    writeFileSync(extensions, `[req]
distinguished_name = dn
[dn]
CN = localhost
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1,DNS:localhost
`);
    const openssl = Bun.which("openssl") ?? (windows ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "openssl.exe") : "openssl");
    for (const args of [
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", caKey, "-out", ca, "-days", "1", "-subj", "/CN=Sidecar test CA", "-config", extensions, "-extensions", "ca"],
      ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=localhost", "-config", extensions],
      ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-set_serial", "2", "-sha256", "-days", "1", "-out", cert, "-extfile", extensions, "-extensions", "server"],
    ]) {
      const generated = Bun.spawnSync([openssl, ...args]);
      if (generated.exitCode !== 0) throw new Error(`TLS fixture generation failed: ${generated.stderr.toString()}`);
    }
    const token = "tls+paired/token?secret";
    const frames: DeviceClientFrame[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      tls: { cert: Bun.file(cert), key: Bun.file(key) },
      fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname !== "/api/devices" || url.searchParams.get("access_token") !== token) return new Response(null, { status: 401 });
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        message(ws, message) {
          const frame = JSON.parse(String(message)) as DeviceClientFrame;
          frames.push(frame);
          if (frame.type === "register") {
            ws.send(JSON.stringify({ type: "registered", deviceId: DEVICE }));
            ws.send(JSON.stringify({ type: "local.job", jobId: "tls-smoke", hostname: "tls-laptop", botId: "bot", turnId: "turn", action: "run", command: windows ? "Write-Output 'tls-smoke'" : "printf tls-smoke" }));
          }
        },
      },
    });
    const env = { ...process.env, OMARCHY_BOT_SERVICE_URL: `wss://127.0.0.1:${server.port}`, OMARCHY_BOT_DEVICE_ID: DEVICE, OMARCHY_BOT_DEVICE_TOKEN: token, OMARCHY_BOT_SIDECAR_ROOT: root };
    try {
      for (const credentials of [{ NODE_EXTRA_CA_CERTS: "", OMARCHY_BOT_DEVICE_TOKEN: token }, { NODE_EXTRA_CA_CERTS: ca, OMARCHY_BOT_DEVICE_TOKEN: "unpaired" }]) {
        const rejected = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env: { ...env, ...credentials } });
        const output = Promise.all([new Response(rejected.stdout).text(), new Response(rejected.stderr).text()]);
        try {
          await until(() => rejected.exitCode !== null, "untrusted or unpaired TLS Sidecar did not exit");
          expect(await rejected.exited).toBe(1);
          expect((await output)[0]).not.toContain('"type":"registered"');
          expect(frames).toHaveLength(0);
        } finally {
          if (rejected.exitCode === null) rejected.kill();
          await rejected.exited;
          await output;
        }
      }
      const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...env, NODE_EXTRA_CA_CERTS: ca } });
      let stdout = "";
      const output = (async () => { for await (const chunk of child.stdout) stdout += new TextDecoder().decode(chunk); })();
      const errors = new Response(child.stderr).text();
      try {
        await until(() => stdout.includes('"type":"ask"') || child.exitCode !== null, "TLS Sidecar never asked");
        if (child.exitCode !== null) throw new Error(`Trusted TLS Sidecar exited ${child.exitCode} before approval: ${(await errors).replaceAll(token, "<REDACTED>").replaceAll(encodeURIComponent(token), "<REDACTED>")}`);
        expect(frames[0]).toMatchObject({ type: "register", os: windows ? "windows" : process.platform === "darwin" ? "macos" : "linux", shell: windows ? "powershell-5.1" : "posix-sh" });
        child.stdin.write(`${JSON.stringify({ type: "allow-once", jobId: "tls-smoke" })}\n`);
        await until(() => frames.some((frame) => frame.type === "local.result"), "TLS command never returned");
        const result = frames.find((frame) => frame.type === "local.result");
        expect(result).toMatchObject({ type: "local.result", jobId: "tls-smoke", ok: true, exitCode: 0 });
        if (result?.type !== "local.result" || !result.ok || result.text === undefined) throw new Error("TLS command failed");
        expect(result.text.trim()).toBe("tls-smoke");
        await server.stop(true);
        await until(() => child.exitCode !== null, "TLS Sidecar did not close after disconnect");
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
        await Promise.all([output, errors]);
      }
    } finally {
      await server.stop(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

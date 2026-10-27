import { expect, test } from "bun:test";
import path from "node:path";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { MessageDto, ThreadDto } from "../../packages/protocol/src/api.ts";

const image = process.env.OMARCHY_BOT_CONTAINER_IMAGE;
const containerTest = image ? test : test.skip;
const runtime = "/opt/omarchy-bot/runtime";

async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`docker ${args[0]} failed (${code}): ${stderr}`);
  return stdout.trim();
}

async function until<T>(read: () => Promise<T | undefined>, description: string, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out: ${description}`);
    // Docker, browser windows and Service readiness are external processes; fake time cannot advance them.
    await Bun.sleep(200);
  }
}

containerTest("archive image serves paired Bots and offline Bot Screens and retains one state volume", async () => {
  const name = `ob-container-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const volume = `${name}-state`;
  let token = "";
  // Exercise the normal loopback listener with no network interface or download access.
  async function request(route: string, body?: unknown, bearer = token): Promise<Response> {
    const serialized = await docker("exec", name, "bun", "-e", `
      const [route, body, token] = process.argv.slice(1);
      const response = await fetch("http://127.0.0.1:7321" + route, {
        method: body ? "POST" : "GET",
        headers: {"content-type":"application/json", "x-command-id":crypto.randomUUID(), ...(token ? {authorization:"Bearer " + token} : {})},
        ...(body ? {body} : {})
      });
      console.log(JSON.stringify({status:response.status, body:Buffer.from(await response.arrayBuffer()).toString("base64")}));
    `, route, body === undefined ? "" : JSON.stringify(body), bearer);
    const result = JSON.parse(serialized) as { status: number; body: string };
    return new Response(Buffer.from(result.body, "base64"), { status: result.status });
  }
  async function api<T>(route: string, body?: unknown): Promise<T> {
    const response = await request(route, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`${route}: ${response.status} ${text}`);
    return JSON.parse(text);
  }
  const healthy = () => until(async () => {
    try {
      const r = await request("/api/health", undefined, "");
      return r.ok ? r.json() : undefined;
    } catch { return undefined; }
  }, "Service health");
  const launch = () => docker("run", "-d", "--pull=never", "--name", name, "--network=none",
    "--shm-size=512m", "--security-opt", "seccomp=unconfined",
    "--mount", `type=volume,source=${volume},target=/var/lib/omarchy-bot`,
    "--mount", `type=bind,source=${path.resolve(import.meta.dir, "fake-workers")},target=${runtime}/tests/integration/fake-workers,readonly`,
    "--env", `OMARCHY_BOT_WORKERS_DIR=${runtime}/tests/integration/fake-workers`,
    "--env", "OMARCHY_BOT_SCREEN_PROFILE=720p", image!);
  const title = `OFFLINE-${name}`;
  // Same origin after recreation: browser localStorage must survive on the state volume.
  const page = `<title>${title}</title><script>let n=Number(localStorage.visits||0)+1;localStorage.visits=n;document.title='${title} visits:'+n</script>`;
  const startPage = () => docker("exec", "--detach", name, "bun", "-e",
    `Bun.serve({hostname:'127.0.0.1',port:7999,fetch:()=>new Response(${JSON.stringify(page)},{headers:{'content-type':'text/html'}})});`);
  try {
    await docker("volume", "create", volume);
    await launch();
    await docker("exec", name, "sh", "-c", 'mkdir -p "$OMARCHY_BOT_HOME/conformance"; printf %s \'{"ok":true,"image":"verified"}\' > "$OMARCHY_BOT_HOME/conformance/pi-fake-pi-1.json"');
    expect(await healthy()).toEqual({ ok: true, version: "0.1.0" });
    expect(Number(await docker("exec", name, "id", "-u"))).toBeGreaterThan(0);
    expect(await docker("exec", name, "bun", "-e", 'console.log(require("node:fs").readFileSync("/proc/1/status", "utf8").match(/^Uid:\\s+(\\d+)/m)[1])')).toBe("1000");
    expect(await docker("inspect", "--format", "{{.HostConfig.NetworkMode}}", name)).toBe("none");
    const mounts = JSON.parse(await docker("inspect", "--format", "{{json .Mounts}}", name)) as Array<{ Type: string; Destination: string }>;
    expect(mounts.filter((mount) => mount.Type === "volume").map((mount) => mount.Destination)).toEqual(["/var/lib/omarchy-bot"]);
    expect((await request("/api/bots", undefined, "")).status).toBe(401);
    const secret = await docker("exec", name, "cat", "/var/lib/omarchy-bot/state/pairing-host-secret");
    const issued = await request("/api/pairing/codes", { name: "Container Client" }, secret);
    expect(issued.status).toBe(200);
    const { code } = await issued.json() as { code: string };
    const exchanged = await request("/api/pairing/exchange", { code, name: "Container Client" }, "");
    expect(exchanged.status).toBe(201);
    const paired = await exchanged.json() as { token: string; device: { id: string } };
    token = paired.token;
    await until(async () => {
      const agents = await api<Array<{ id: string; status: string }>>("/api/agents");
      return agents.some((agent) => agent.id === "pi" && agent.status === "ready") ? true : undefined;
    }, "scripted Agent readiness");
    const bot = await api<{ id: string; surfaceId: string }>("/api/bots", { name: "Container Bot", agentId: "pi" });
    let threadId: string | undefined;
    async function turn(text: string): Promise<MessageDto[]> {
      const previousIds = new Set((threadId ? await api<MessageDto[]>(`/api/threads/${threadId}/messages`) : []).map((message) => message.id));
      const sent = await api<{ threadId: string; turnId: string }>(threadId ? `/api/threads/${threadId}/messages` : `/api/bots/${bot.id}/messages`, { text });
      threadId = sent.threadId;
      const thread = await until(async () => {
        const current = await api<ThreadDto>(`/api/threads/${sent.threadId}`);
        return current.activeTurn === undefined ? current : undefined;
      }, `Turn ${text}`);
      expect(thread.latestTurn).toMatchObject({ id: sent.turnId, status: "completed" });
      return (await api<MessageDto[]>(`/api/threads/${sent.threadId}/messages`)).filter((message) => !previousIds.has(message.id));
    }
    async function waitBrowser(visits: number): Promise<void> {
      let lastObservation = "";
      await until(async () => {
        const transcript = await turn("computer:observe");
        lastObservation = transcript.map((message) => message.text ?? "").join("\n");
        return transcript.some((message) => message.text?.includes(`${title} visits:${visits}`) && message.text.includes('"windowList"')) ? true : undefined;
      }, `offline browser visits:${visits}`).catch((error) => { throw new Error(`${error}\nLast observation: ${lastObservation}`); });
    }
    expect((await turn("say: container turn works")).some((message) => message.text === "container turn works")).toBe(true);
    const observed = await turn("computer:observe");
    expect(observed.some((message) => message.text?.includes('"imageRef"') && message.text.includes(bot.surfaceId))).toBe(true);
    await startPage();
    await turn("computer:open_url:http://127.0.0.1:7999/");
    await waitBrowser(1);
    const executables = await docker("exec", name, "bun", "-e", 'const fs = require("node:fs"); for (const pid of fs.readdirSync("/proc").filter(p => /^\\d+$/.test(p))) { try { console.log(fs.readlinkSync(`/proc/${pid}/exe`)); } catch {} }');
    expect(executables).toContain("/opt/omarchy-bot/browser/chrome-linux64/chrome");
    expect(executables).toContain("/opt/omarchy-bot/runtime/sway/");
    expect(await api(`/api/computer/state?botId=${bot.id}&surfaceId=${bot.surfaceId}`)).toMatchObject({ state: "ready" });
    const snapshot = await request(`/api/computer/snapshot?botId=${bot.id}&surfaceId=${bot.surfaceId}`);
    expect(snapshot.status).toBe(200);
    const png = Buffer.from(await snapshot.arrayBuffer());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 720]);
    await until(async () => (await docker("inspect", "--format", "{{.State.Health.Status}}", name)) === "healthy" ? true : undefined, "Docker HEALTHCHECK");
    expect(await docker("logs", name)).toContain("omarchy-bot daemon listening");
    await docker("exec", name, "sh", "-c", 'printf workspace > "$HOME/workspace-marker"');
    const before = await api<MessageDto[]>(`/api/threads/${threadId}/messages`);
    await docker("stop", "--time", "20", name);
    expect(await docker("logs", name)).toContain("omarchy-bot daemon stopped");
    expect(await docker("inspect", "--format", "{{.State.ExitCode}}", name)).toBe("0");
    await docker("rm", name);
    // Recreate to prove that state comes from the volume, not the container writable layer.
    await launch();
    await healthy();
    expect(await api(`/api/bots/${bot.id}`)).toMatchObject({ id: bot.id });
    expect(await api<MessageDto[]>(`/api/threads/${threadId}/messages`)).toEqual(before);
    expect((await api<{ devices: Array<{ id: string }> }>("/api/devices/paired")).devices.some((device) => device.id === paired.device.id)).toBe(true);
    expect(await docker("exec", name, "cat", "/var/lib/omarchy-bot/home/workspace-marker")).toBe("workspace");
    await until(async () => (await api<Array<{ id: string; status: string }>>("/api/agents")).some((agent) => agent.id === "pi" && agent.status === "ready") ? true : undefined, "Agent after recreation");
    await startPage();
    await turn("computer:open_url:http://127.0.0.1:7999/");
    await waitBrowser(2);
    const afterRecreation = await api<MessageDto[]>(`/api/threads/${threadId}/messages`);
    await docker("restart", "--time", "20", name);
    await healthy();
    expect(await api(`/api/bots/${bot.id}`)).toMatchObject({ id: bot.id });
    expect(await api<MessageDto[]>(`/api/threads/${threadId}/messages`)).toEqual(afterRecreation);
    expect((await api<{ devices: Array<{ id: string }> }>("/api/devices/paired")).devices.some((device) => device.id === paired.device.id)).toBe(true);
    await until(async () => (await api<Array<{ id: string; status: string }>>("/api/agents")).some((agent) => agent.id === "pi" && agent.status === "ready") ? true : undefined, "Agent after restart");
    await startPage();
    await turn("computer:open_url:http://127.0.0.1:7999/");
    await waitBrowser(3);
    await until(async () => (await docker("inspect", "--format", "{{.State.Health.Status}}", name)) === "healthy" ? true : undefined, "Docker HEALTHCHECK after restart");
  } catch (error) {
    console.error(await docker("logs", name).catch(() => "container did not start"));
    throw error;
  } finally {
    await docker("rm", "--force", name).catch(() => {});
    await docker("volume", "rm", volume).catch(() => {});
    expect(await docker("ps", "--all", "--quiet", "--filter", `name=^/${name}$`)).toBe("");
    expect(await docker("volume", "ls", "--quiet", "--filter", `name=^${volume}$`)).toBe("");
  }
}, 300_000);

containerTest("fresh TLS image prints a one-time pairing URL and exec CLI supports HTTPS", async () => {
  const name = `ob-container-tls-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const volume = `${name}-state`;
  const root = mkdtempSync(path.join(tmpdir(), "ob-container-tls-"));
  const cert = path.join(root, "cert.pem"), key = path.join(root, "key.pem");
  try {
    expect(Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "1", "-nodes", "-subj", "/CN=localhost"]).exitCode).toBe(0);
    chmodSync(root, 0o755); chmodSync(key, 0o644);
    await docker("volume", "create", volume);
    await docker("run", "-d", "--pull=never", "--name", name, "--network=none",
      "--mount", `type=volume,source=${volume},target=/var/lib/omarchy-bot`,
      "--mount", `type=bind,source=${root},target=/fixture-tls,readonly`,
      "--env", "OMARCHY_BOT_TLS_CERT=/fixture-tls/cert.pem", "--env", "OMARCHY_BOT_TLS_KEY=/fixture-tls/key.pem", image!);
    const lines = await until(async () => {
      const lines = (await docker("logs", name)).split("\n").filter(line => line.startsWith("pairing:"));
      return lines.length ? lines : undefined;
    }, "TLS first-start pairing URL");
    expect(lines).toHaveLength(1);
    const url = new URL(lines[0]!.slice("pairing: ".length));
    expect(url.origin).toBe("https://127.0.0.1:7321");
    const code = url.searchParams.get("code");
    const exchange = await docker("exec", name, "bun", "-e", `
      const response=await fetch("https://127.0.0.1:7321/api/pairing/exchange",{tls:{rejectUnauthorized:false},method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:process.argv[1],name:"TLS container client"})});
      const body=await response.json();console.log(JSON.stringify({status:response.status,id:body.device?.id}));`, code!);
    const paired = JSON.parse(exchange) as { status: number; id: string };
    expect(paired.status).toBe(201);
    const execCli = (...args: string[]) => docker("exec", name, "bun", `${runtime}/apps/cli/src/main.ts`, ...args);
    expect(await execCli("devices")).toContain(`${paired.id}\tTLS container client`);
    expect(await execCli("pair")).toMatch(/^pairing: https:\/\/127\.0\.0\.1:7321\/pair\?code=/);
    await until(async () => await docker("inspect", "--format", "{{.State.Health.Status}}", name) === "healthy" ? true : undefined, "TLS Docker health");
    await docker("restart", "--time", "20", name);
    await until(async () => { try { return (await execCli("devices")).includes(paired.id) ? true : undefined; } catch { return undefined; } }, "paired TLS restart");
    expect((await docker("logs", name)).split("\n").filter(line => line.startsWith("pairing:"))).toHaveLength(1);
    await execCli("revoke", paired.id);
    await docker("stop", "--time", "20", name);
    expect(await docker("inspect", "--format", "{{.State.ExitCode}}", name)).toBe("0");
  } finally {
    await docker("rm", "--force", name).catch(() => {});
    await docker("volume", "rm", volume).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

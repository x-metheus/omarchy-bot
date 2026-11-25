import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, mkdtemp, mkdir, rm, rmdir, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerClient } from "../../apps/daemon/src/supervision/workerClient.ts";
import type { NativeMcpControlResult, NativePluginResources, ProbePayload } from "../../packages/agent-contract/src/index.ts";
import type { PluginStateDto } from "../../packages/protocol/src/plugins.ts";
import { api, startDaemon, type Harness } from "./helpers/harness.ts";

test("the Service rejects startup when its Pi agent directory is a symlink", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-agent-startup-symlink-"));
  const previousHome = process.env.HOME;
  const dataDir = path.join(home, "service-data");
  const piAgentDir = path.join(dataDir, "pi-agent");
  const userAgentDir = path.join(home, ".pi", "agent");
  const authFile = path.join(userAgentDir, "auth.json");
  const sentinel = Buffer.from('{"openai":{"type":"api_key","key":"fixture-pi-user-key"}}\n');
  const workerStart = spyOn(WorkerClient.prototype, "start");
  let harness: Harness | undefined;
  try {
    await mkdir(dataDir);
    await mkdir(userAgentDir, { recursive: true, mode: 0o700 });
    await writeFile(authFile, sentinel, { mode: 0o600 });
    await utimes(authFile, 946684800, 946684800);
    const before = await lstat(authFile);
    await symlink(userAgentDir, piAgentDir);

    const startup = startDaemon(home, { dataDir, stateDir: path.join(home, "service-state"), waitForAgentReady: false });
    await expect(startup.then((started) => { harness = started; }))
      .rejects.toThrow(`Pi agent directory ${piAgentDir} must be a real directory`);
    expect(workerStart).not.toHaveBeenCalled();
    expect(await readlink(piAgentDir)).toBe(userAgentDir);
    expect((await lstat(authFile)).atimeMs).toBe(before.atimeMs);
    expect(await readFile(authFile)).toEqual(sentinel);
  } finally {
    workerStart.mockRestore();
    try { await harness?.stop(); }
    finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  }
}, 45_000);

test("the Service rejects a Pi agent directory symlink before launching the worker", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-agent-symlink-"));
  const previousHome = process.env.HOME;
  const dataDir = path.join(home, "service-data");
  const piAgentDir = path.join(dataDir, "pi-agent");
  const userAgentDir = path.join(home, ".pi", "agent");
  const authFile = path.join(userAgentDir, "auth.json");
  const sentinel = Buffer.from('{"openai":{"type":"api_key","key":"fixture-pi-user-key"}}\n');
  const workersDir = path.join(home, "workers");
  const scriptDir = path.join(workersDir, "pi", "src");
  const workerStarted = path.join(home, "worker-started");
  const realWorker = path.resolve(import.meta.dir, "../../workers/pi/src/worker.ts");
  let harness: Harness | undefined;
  try {
    await mkdir(dataDir);
    await mkdir(userAgentDir, { recursive: true, mode: 0o700 });
    await writeFile(authFile, sentinel, { mode: 0o600 });
    await utimes(authFile, 946684800, 946684800);
    const before = await lstat(authFile);

    // Keep the worker absent during the background startup probe.
    harness = await startDaemon(home, { dataDir, workersDir, stateDir: path.join(home, "service-state"), waitForAgentReady: false });
    await rmdir(piAgentDir);
    await symlink(userAgentDir, piAgentDir);
    await mkdir(scriptDir, { recursive: true });
    await writeFile(path.join(scriptDir, "worker.ts"), `
      await Bun.write(${JSON.stringify(workerStarted)}, "started");
      await import(${JSON.stringify(realWorker)});
    `);

    await expect(harness.svc.supervisor.agentWorker("pi"))
      .rejects.toThrow(`Pi agent directory ${piAgentDir} must be a real directory`);

    await expect(lstat(workerStarted)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readlink(piAgentDir)).toBe(userAgentDir);
    expect((await lstat(authFile)).atimeMs).toBe(before.atimeMs);
    expect(await readFile(authFile)).toEqual(sentinel);
  } finally {
    try { await harness?.stop(); }
    finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  }
}, 45_000);

test("the Service's Pi probe and Services inventory leave the user's Pi home untouched", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-home-isolation-"));
  const agentDir = path.join(home, ".pi", "agent");
  const skillDir = path.join(agentDir, "skills", "user-pi-skill");
  const previousHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  let harness: Harness | undefined;
  try {
    await mkdir(skillDir, { recursive: true });
    const homeFiles = [
      [path.join(agentDir, "auth.json"), '{"openai":{"type":"api_key","key":"fixture-pi-user-key"}}'],
      [path.join(agentDir, "settings.json"), '{}'],
      [path.join(skillDir, "SKILL.md"), "---\nname: user-pi-skill\ndescription: Sentinel in the user's Pi home\n---\n"],
    ] as const;
    for (const [file, text] of homeFiles) {
      await writeFile(file, text, { mode: 0o600 });
      await utimes(file, 946684800, 946684800);
    }
    const before = await Promise.all(homeFiles.map(([file]) => lstat(file)));
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://pi-home-catalog.invalid/api/plugins/providers") return Response.json([]);
      return originalFetch(input, init);
    }, { preconnect: originalFetch.preconnect });
    harness = await startDaemon(home, { workersDir: path.resolve(import.meta.dir, "../../workers"), waitForAgentReady: false });
    const appAgentDir = path.join(harness.svc.cfg.dataDir, "pi-agent");
    const appAgentStat = await lstat(appAgentDir);
    expect(appAgentStat.isDirectory()).toBe(true);
    expect(appAgentStat.mode & 0o7777).toBe(0o700);
    expect(appAgentStat).toMatchObject({ uid: process.geteuid?.() });
    const appSkillDir = path.join(appAgentDir, "skills", "app-pi-skill");
    const appSkillFile = path.join(appSkillDir, "SKILL.md");
    await mkdir(appSkillDir, { recursive: true });
    await writeFile(appSkillFile, "---\nname: app-pi-skill\ndescription: Skill in the Service's Pi directory\n---\n");
    harness.svc.plugins.configure("https://pi-home-catalog.invalid");
    const worker = await harness.svc.supervisor.agentWorker("pi");
    const probe: ProbePayload = await worker.request({ type: "probe" }, 30_000);
    expect(probe).toMatchObject({ sdkOk: true, reason: expect.stringContaining("no authenticated model provider") });
    const workerResources: NativePluginResources = await worker.request({ type: "resources.list", cwd: harness.svc.cfg.sharedWorkspaceDir }, 30_000);
    expect(workerResources.skills).toContainEqual(expect.objectContaining({ name: "app-pi-skill", path: appSkillFile }));
    expect(workerResources.skills.some((skill) => skill.name === "user-pi-skill")).toBe(false);

    const state = await api<PluginStateDto>(harness, "GET", "/api/plugins");
    expect(state.nativeError).toBeUndefined();
    expect(state.skills).toContainEqual(expect.objectContaining({ name: "skill-creator", origin: "default", enabled: true }));
    expect(state.nativeSkills).toEqual([]);
    await harness.stop();
    harness = undefined;

    expect((await readdir(agentDir)).sort()).toEqual(["auth.json", "settings.json", "skills"]);
    for (const [index, [file, text]] of homeFiles.entries()) {
      const after = await lstat(file);
      expect(after).toMatchObject({ atimeMs: before[index]!.atimeMs, mtimeMs: before[index]!.mtimeMs, mode: before[index]!.mode });
      expect(await readFile(file, "utf8")).toBe(text);
    }
  } finally {
    try { await harness?.stop(); }
    finally {
      globalThis.fetch = originalFetch;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  }
}, 45_000);

test("a native project adapter connects without model credentials, retains private env across edits and releases removed idle children", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-mcp-runtime-"));
  const workspace = path.join(home, ".omarchy-bot", "workspace");
  const root = path.resolve(import.meta.dir, "../..");
  const server = path.join(home, "server.ts");
  const evidence = path.join(home, "counter-process.json");
  const token = crypto.randomUUID();
  const originalFetch = globalThis.fetch;
  let harness: Harness | undefined;
  const worker = new WorkerClient({ name: "native-mcp-runtime", script: path.join(root, "workers/pi/src/worker.ts"), env: {
    HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", OMARCHY_BOT_HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
  }, onEvent: () => {} });
  try {
    await mkdir(path.join(workspace, ".pi"), { recursive: true });
    // Keep the project package registration: the worker also installs its native
    // adapter, so this exercises real duplicate-factory collision prevention.
    const settingsPath = path.join(workspace, ".pi", "settings.json");
    const settings = JSON.stringify({ packages: [path.join(root, "workers/pi/node_modules/pi-mcp-adapter")] });
    await writeFile(settingsPath, settings);
    await writeFile(server, `
import { writeFileSync } from "node:fs";
import { McpServer } from ${JSON.stringify(Bun.resolveSync("@modelcontextprotocol/sdk/server/mcp.js", path.join(root, "apps/daemon")))};
import { StdioServerTransport } from ${JSON.stringify(Bun.resolveSync("@modelcontextprotocol/sdk/server/stdio.js", path.join(root, "apps/daemon")))};
if (process.env.NATIVE_COUNTER_TOKEN !== ${JSON.stringify(token)}) throw new Error("Private fixture authentication required");
writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ pid: process.pid, argument: process.argv[2] }), { mode: 0o600 });
const server = new McpServer({ name: "native-counter", version: "1" });
server.registerTool("count", { description: "Return the current fixture count", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "count=1" }] }));
await server.connect(new StdioServerTransport());
`, { mode: 0o600 });
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === "https://native-runtime-catalog.invalid" && url.pathname === "/api/plugins/providers") return Response.json([]);
      return originalFetch(input, init);
    }, { preconnect: originalFetch.preconnect });
    await worker.start();
    harness = await startDaemon(home);
    const service = harness.svc.plugins;
    const runtime = harness.svc.turns["runtime"];
    service.configure("https://native-runtime-catalog.invalid");
    const connection = await service.saveMcp(null, { name: "counter", enabled: true,
      transport: { type: "stdio", command: process.execPath, args: [server, "initial"], env: { NATIVE_COUNTER_TOKEN: token } } });
    expect(connection.pendingReload).toBe(true);
    expect(await readFile(path.join(workspace, ".mcp.json"), "utf8")).not.toContain(token);

    const listWorkerResources = (): Promise<NativePluginResources> => worker.request({ type: "resources.list", cwd: workspace }, 30_000);
    const result: NativeMcpControlResult = await worker.request({ type: "mcp.control", cwd: workspace, action: "connect", server: "counter" }, 30_000);
    expect(result.result?.error).toBeUndefined();
    const initialWorkerStatus = result.servers.find((entry) => entry.name === "counter");
    expect(initialWorkerStatus).toMatchObject({ status: "connected", toolCount: 1 });
    const initialEvidence = JSON.parse(await readFile(evidence, "utf8"));
    expect(initialEvidence.argument).toBe("initial");
    if (!Number.isSafeInteger(initialEvidence.pid) || initialEvidence.pid <= 1) throw new Error("Fixture did not record a valid owned child PID");
    expect((await listWorkerResources()).mcp).toContainEqual(initialWorkerStatus);

    // Services observes the durable connection only after that runtime connects.
    const beforeDurableConnect = await api<PluginStateDto>(harness, "GET", "/api/plugins");
    expect(beforeDurableConnect.mcp.find((entry) => entry.id === connection.id)).toMatchObject({ status: "not-connected", toolCount: 0 });
    const durable = await runtime.mcpControl({ action: "connect", server: "counter" });
    expect(durable.result?.error).toBeUndefined();
    expect(durable.servers).toContainEqual(expect.objectContaining({
      name: "counter", status: "connected", toolCount: 1, configurationRevision: service.mcp.effectiveServers().revision,
    }));
    const connected = await api<PluginStateDto>(harness, "GET", "/api/plugins");
    expect(connected.mcp.find((entry) => entry.id === connection.id)).toMatchObject({ status: "connected", toolCount: 1, pendingReload: false });
    expect(JSON.stringify(connected)).not.toContain(token);

    // Omitted env means keep the private binding for this same executable,
    // even though its non-secret argument changes the configuration revision.
    const edited = await service.saveMcp(connection.id, { name: "counter", enabled: true,
      transport: { type: "stdio", command: process.execPath, args: [server, "edited"] } });
    expect(edited.pendingReload).toBe(true);
    const reconnected: NativeMcpControlResult = await worker.request({ type: "mcp.control", cwd: workspace, action: "connect", server: "counter" }, 30_000);
    expect(reconnected.result?.error).toBeUndefined();
    const editedWorkerStatus = reconnected.servers.find((entry) => entry.name === "counter");
    expect(editedWorkerStatus).toMatchObject({ status: "connected", toolCount: 1 });
    const editedEvidence = JSON.parse(await readFile(evidence, "utf8"));
    expect(editedEvidence.argument).toBe("edited");
    if (!Number.isSafeInteger(editedEvidence.pid) || editedEvidence.pid <= 1) throw new Error("Fixture did not record a valid owned child PID");
    expect(editedEvidence.pid).not.toBe(initialEvidence.pid);
    expect((await listWorkerResources()).mcp).toContainEqual(editedWorkerStatus);
    expect((await runtime.mcpControl({ action: "connect", server: "counter" })).result?.error).toBeUndefined();
    const editedState = await api<PluginStateDto>(harness, "GET", "/api/plugins");
    expect(editedState.mcp.find((entry) => entry.id === connection.id)).toMatchObject({ status: "connected", toolCount: 1, pendingReload: false });
    const ownedChildIsAlive = (): boolean => {
      try { process.kill(editedEvidence.pid, 0); return true; }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
        throw error;
      }
    };
    expect(ownedChildIsAlive()).toBe(true);

    service.removeMcp(connection.id);
    // No worker request, Check or shutdown may trigger disposal here. The
    // worker's idle reconciliation must close the obsolete stdio session.
    const deadline = performance.now() + 10_000;
    // The reconciliation timer runs in a separate real worker process, so fake
    // timers in this test cannot advance it; poll its owned child's exit instead.
    while (ownedChildIsAlive() && performance.now() < deadline) await Bun.sleep(100);
    expect(ownedChildIsAlive()).toBe(false);
    expect(await readFile(settingsPath, "utf8")).toBe(settings);
    for (const retired of [".pi/mcp.json", ".codex"]) await expect(lstat(path.join(workspace, retired))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    globalThis.fetch = originalFetch;
    try { await harness?.stop(); }
    finally {
      try { await worker.stop(); }
      finally { await rm(home, { recursive: true, force: true }); }
    }
  }
}, 90_000);

test("Bun OAuth locks remain exclusive against native Node clients until release, including cancelled waiters", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-mcp-lock-"));
  const adapter = path.dirname(Bun.resolveSync("pi-mcp-adapter", path.resolve(import.meta.dir, "../../workers/pi")));
  const { acquireRefreshLock } = await import(path.join(adapter, "mcp-refresh-lock.ts"));
  const lockFile = path.join(home, "refresh-locks-v2", createHash("sha256").update("shared-account").digest("hex"));
  const probe = async (): Promise<number> => {
    const child = Bun.spawn(["node", "-e",
      `const {createRequire}=require('node:module'); const load=createRequire(process.argv[1]); const fd=require('node:fs').openSync(process.argv[2],'a+'); process.exit(load('fs-native-extensions').tryLock(fd)?0:1);`,
      path.join(adapter, "package.json"), lockFile], { stdout: "ignore", stderr: "pipe" });
    const code = await child.exited;
    if (code !== 0 && code !== 1) throw new Error(await new Response(child.stderr).text());
    return code;
  };
  let lock: { release(): void } | undefined;
  try {
    const held: { release(): void } = await acquireRefreshLock("shared-account", home);
    lock = held;
    expect(await probe()).toBe(1);
    const abort = new AbortController();
    const waiting = acquireRefreshLock("shared-account", home, abort.signal);
    abort.abort(new Error("cancelled fixture waiter"));
    await expect(waiting).rejects.toThrow("cancelled fixture waiter");
    expect(await probe()).toBe(1);
    lock.release();
    lock = undefined;
    expect(await probe()).toBe(0);
  } finally {
    lock?.release();
    await rm(home, { recursive: true, force: true });
  }
}, 20_000);

test("a real native HTTP connection publishes needs-auth rather than a stale not-connected snapshot", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-mcp-auth-status-"));
  const root = path.resolve(import.meta.dir, "../..");
  const script = path.join(home, "auth-status.ts");
  try {
    // Isolate the native keychain's OS home as well as HOME. A process-local mock
    // must not alter the daemon or other tests' identity and credential storage.
    await writeFile(script, `
import os from "node:os";
import { mock } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const home = process.env.HOME!;
const userInfo = os.userInfo;
const privateUserInfo = () => ({ ...userInfo(), homedir: home });
mock.module("node:os", () => ({ ...os, userInfo: privateUserInfo, default: { ...os, userInfo: privateUserInfo } }));
const { NativeMcp, nativeMcpStatus } = await import(${JSON.stringify(path.join(root, "workers/pi/src/native-mcp.ts"))});
const { createAgentSession, SessionManager, ModelRuntime, getAgentDir } = await import(${JSON.stringify(Bun.resolveSync("@earendil-works/pi-coding-agent", path.join(root, "workers/pi")))});
const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  const base = url.origin;
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource: base + "/mcp", authorization_servers: [base] });
  if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: base, authorization_endpoint: base + "/authorize", token_endpoint: base + "/token", registration_endpoint: base + "/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
  if (url.pathname === "/register") return Response.json({ ...await request.json(), client_id: "fixture-client", token_endpoint_auth_method: "none" }, { status: 201 });
  return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource/mcp"' } });
} });
const cwd = path.join(home, "workspace");
await mkdir(cwd);
await writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { consent: { type: "http", url: "http://127.0.0.1:" + http.port + "/mcp" } } }));
const native = new NativeMcp(cwd);
let session;
try {
  await native.load();
  ({ session } = await createAgentSession({ cwd, agentDir: getAgentDir(), resourceLoader: native.loader, sessionManager: SessionManager.inMemory(cwd), modelRuntime: await ModelRuntime.create() }));
  await native.bind(session);
  const gateway = session.getToolDefinition("mcp");
  const result = await gateway.execute("auth-status", { connect: "consent" }, AbortSignal.timeout(20_000), undefined, session.extensionRunner.createContext());
  const status = nativeMcpStatus(cwd).find(server => server.name === "consent");
  console.log(JSON.stringify({ error: result.details.error, status: status?.status, toolCount: status?.toolCount }));
} finally {
  await native.dispose(session);
  await http.stop(true);
}
`, { mode: 0o600 });
    const child = Bun.spawn([process.execPath, script], {
      cwd: root, stdout: "pipe", stderr: "pipe", timeout: 45_000,
      env: { ...process.env, HOME: home, OMARCHY_BOT_HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
        PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"),
        // The adapter treats any other value as "use the OS keyring"; tests must never reach the real one.
        PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Native OAuth status fixture failed (${code}): ${stderr}`);
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
      error: "auth_required", status: "needs-auth", toolCount: 0,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

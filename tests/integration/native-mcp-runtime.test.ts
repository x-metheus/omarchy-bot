import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginsService } from "../../apps/daemon/src/modules/plugins/plugins.ts";
import { WorkerClient } from "../../apps/daemon/src/supervision/workerClient.ts";
import type { NativeMcpControlResult } from "../../packages/agent-contract/src/index.ts";

test("a native project adapter connects without model credentials, retains private env across edits and releases removed idle children", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-mcp-runtime-"));
  const workspace = path.join(home, "workspace");
  const root = path.resolve(import.meta.dir, "../..");
  const server = path.join(home, "server.ts");
  const evidence = path.join(home, "counter-process.json");
  const token = crypto.randomUUID();
  const originalFetch = globalThis.fetch;
  let service: PluginsService | undefined;
  const worker = new WorkerClient({ name: "native-mcp-runtime", script: path.join(root, "workers/pi/src/worker.ts"), env: {
    HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", OMARCHY_BOT_HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
  }, onEvent: () => {} });
  try {
    await mkdir(path.join(workspace, ".pi"), { recursive: true });
    // Keep the project package registration: the worker also installs its native
    // adapter, so this exercises real duplicate-factory collision prevention.
    await writeFile(path.join(workspace, ".pi", "settings.json"), JSON.stringify({ packages: [path.join(root, "workers/pi/node_modules/pi-mcp-adapter")] }));
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
    service = new PluginsService(path.join(home, "plugins"), workspace,
      () => worker.request({ type: "resources.list", cwd: workspace }, 15_000),
      (input) => worker.request({ type: "mcp.control", cwd: workspace, ...input }, 30_000));
    service.configure("https://native-runtime-catalog.invalid");
    const connection = await service.saveMcp(null, { name: "counter", enabled: true,
      transport: { type: "stdio", command: process.execPath, args: [server, "initial"], env: { NATIVE_COUNTER_TOKEN: token } } });
    expect(connection.pendingReload).toBe(true);
    expect(await readFile(path.join(workspace, ".mcp.json"), "utf8")).not.toContain(token);

    // Connect outside PluginsService.checkMcp: only the actual resources.list
    // observation may acknowledge this saved configuration.
    const result: NativeMcpControlResult = await worker.request({ type: "mcp.control", cwd: workspace, action: "connect", server: "counter" }, 30_000);
    expect(result.result?.error).toBeUndefined();
    expect(result.servers.find((entry) => entry.name === "counter")).toMatchObject({ status: "connected", toolCount: 1 });
    const connected = await service.state();
    expect(connected.mcp.find((entry) => entry.id === connection.id)).toMatchObject({ status: "connected", toolCount: 1, pendingReload: false });
    expect(JSON.stringify(connected)).not.toContain(token);
    const initialEvidence = JSON.parse(await readFile(evidence, "utf8"));
    expect(initialEvidence.argument).toBe("initial");
    if (!Number.isSafeInteger(initialEvidence.pid) || initialEvidence.pid <= 1) throw new Error("Fixture did not record a valid owned child PID");

    // Omitted env means keep the private binding for this same executable,
    // even though its non-secret argument changes the configuration revision.
    const edited = await service.saveMcp(connection.id, { name: "counter", enabled: true,
      transport: { type: "stdio", command: process.execPath, args: [server, "edited"] } });
    expect(edited.pendingReload).toBe(true);
    const reconnected: NativeMcpControlResult = await worker.request({ type: "mcp.control", cwd: workspace, action: "connect", server: "counter" }, 30_000);
    expect(reconnected.result?.error).toBeUndefined();
    expect(reconnected.servers.find((entry) => entry.name === "counter")).toMatchObject({ status: "connected", toolCount: 1 });
    expect((await service.state()).mcp.find((entry) => entry.id === connection.id)).toMatchObject({ status: "connected", toolCount: 1, pendingReload: false });
    const editedEvidence = JSON.parse(await readFile(evidence, "utf8"));
    expect(editedEvidence.argument).toBe("edited");
    if (!Number.isSafeInteger(editedEvidence.pid) || editedEvidence.pid <= 1) throw new Error("Fixture did not record a valid owned child PID");
    expect(editedEvidence.pid).not.toBe(initialEvidence.pid);
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
  } finally {
    globalThis.fetch = originalFetch;
    try { await service?.shutdown(); }
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
        PI_MCP_ADAPTER_TEST_AUTH_STORE: path.join(home, "oauth.json") },
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

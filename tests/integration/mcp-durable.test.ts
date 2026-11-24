import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteSetting, setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import { PLUGIN_PROVIDERS, type PluginStateDto } from "../../packages/protocol/src/index.ts";
import { api, makeBot, messages, sendToBot, sendToThread, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

const publisher = "https://durable-mcp-publisher.invalid";
const daemon = path.resolve(import.meta.dir, "../../apps/daemon");

async function withDurableDaemon(root: string, run: (h: Harness) => Promise<void>) {
  const previous = process.env.OMARCHY_TEST_DURABLE;
  // Like other durable integration tests, exercise the durable path in the default suite too.
  process.env.OMARCHY_TEST_DURABLE = "1";
  let h: Harness | undefined;
  try {
    h = await startDaemon(root);
    await run(h);
  } finally {
    try {
      await h?.stop();
    } finally {
      if (previous === undefined) delete process.env.OMARCHY_TEST_DURABLE;
      else process.env.OMARCHY_TEST_DURABLE = previous;
      if (h) await rm(h.svc.cfg.stateDir, { recursive: true, force: true });
    }
  }
}

function childAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("MCP fixture did not record a valid child PID");
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(condition: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 5_000;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(description);
    await Bun.sleep(20);
  }
}

test("durable MCP journals the redacted result, reports Services status, and releases children on abort and shutdown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-durable-"));
  const script = path.join(root, "server.ts");
  const launches = path.join(root, "launches");
  const blocked = path.join(root, "blocked");
  const token = "fixture-durable-stdio-token";
  const fetch = globalThis.fetch;
  const publisherFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === `${publisher}/api/plugins/providers`) return Promise.resolve(Response.json([]));
    return fetch(input, init);
  }, { preconnect: fetch.preconnect }));
  try {
    await writeFile(script, `
import { appendFileSync, writeFileSync } from "node:fs";
import { McpServer } from ${JSON.stringify(Bun.resolveSync("@modelcontextprotocol/sdk/server/mcp.js", daemon))};
import { StdioServerTransport } from ${JSON.stringify(Bun.resolveSync("@modelcontextprotocol/sdk/server/stdio.js", daemon))};
import { z } from ${JSON.stringify(Bun.resolveSync("zod", daemon))};
appendFileSync(${JSON.stringify(launches)}, String(process.pid) + "\\n");
const server = new McpServer({ name: "durable-fixture", version: "1" });
server.registerTool("reflect", { inputSchema: { message: z.string() } }, async ({ message }) => {
  if (message === "block") {
    writeFileSync(${JSON.stringify(blocked)}, String(process.pid));
    await new Promise(() => {});
  }
  return { content: [{ type: "text", text: "reflected " + message + ": " + process.env.SERVICE_TOKEN }] };
});
await server.connect(new StdioServerTransport());
`);
    await withDurableDaemon(root, async (h) => {
      h.svc.plugins.configure(publisher);
      const local = { command: process.execPath, args: [script] };
      h.svc.plugins.mcp.save(null, { name: "local", enabled: true,
        transport: { ...local, type: "stdio", env: { SERVICE_TOKEN: token } },
      });
      const bot = await makeBot(h, "MCP durable");
      const sent = await sendToBot(h, bot, "mcp-durable: call");
      await waitThreadIdle(h, sent.threadId);
      expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
      const expected = "reflected hello: [redacted]";
      const entries = h.svc.db.query<{ record: string }, [string]>(`
        SELECT record FROM pi_entries WHERE conversation_id = (
          SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?
        ) ORDER BY id
      `).all(sent.threadId).map(({ record }) => JSON.parse(record));
      const tools = entries.flatMap(({ model }) => model ?? []).filter(({ role }) => role === "toolResult");
      expect(tools).toEqual([expect.objectContaining({ toolName: "mcp", isError: false, content: [{ type: "text", text: expected }] })]);
      expect(JSON.stringify(entries)).not.toContain(token);
      expect((await messages(h, sent.threadId)).filter(({ kind }) => kind === "response").map(({ text }) => text)).toEqual([expected]);
      const next = await sendToThread(h, sent.threadId, "mcp-durable: recall");
      await waitThreadIdle(h, sent.threadId);
      expect(h.svc.threads.turnRow(next.turnId)?.status).toBe("completed");
      const transcript = await messages(h, sent.threadId);
      expect(transcript.filter(({ kind }) => kind === "response").map(({ text }) => text)).toEqual([expected, `Recalled ${expected}`]);
      expect(JSON.stringify(transcript)).not.toContain(token);

      const configFile = path.join(h.svc.cfg.sharedWorkspaceDir, ".mcp.json");
      const config = JSON.parse(await readFile(configFile, "utf8"));
      config.mcpServers.disabled = { ...local, disabled: true };
      await writeFile(configFile, JSON.stringify(config));
      const state = await api<PluginStateDto>(h, "GET", "/api/plugins");
      expect(state.mcp).toEqual([
        expect.objectContaining({ name: "disabled", enabled: false, status: "disabled", toolCount: 0, pendingReload: false }),
        expect.objectContaining({ name: "local", enabled: true, status: "connected", toolCount: 1, pendingReload: false,
          source: ".mcp.json, .codex/config.toml", transport: { type: "stdio", command: process.execPath, args: [script], envKeys: ["SERVICE_TOKEN"] } }),
      ]);
      expect(JSON.stringify(state)).not.toContain(token);
      deleteSetting(h.svc.db, "runtime");
      const worker = await api<PluginStateDto>(h, "GET", "/api/plugins");
      expect(worker.mcp.find(({ name }) => name === "local")).toMatchObject({ status: "not-connected", toolCount: 0, pendingReload: false });
      setSetting(h.svc.db, "runtime", "durable");

      const aborted = await sendToThread(h, sent.threadId, "mcp-durable: block");
      await waitUntil(() => Bun.file(blocked).exists(), "MCP fixture never entered the blocking call");
      const firstPid = Number(await readFile(blocked, "utf8"));
      expect(childAlive(firstPid)).toBe(true);
      await h.svc.turns.abortTurn(aborted.turnId, "abort MCP fixture");
      await waitThreadIdle(h, sent.threadId);
      expect(h.svc.threads.turnRow(aborted.turnId)).toMatchObject({ status: "cancelled", outcome_reason: "abort MCP fixture" });
      await waitUntil(() => !childAlive(firstPid), "MCP child remained alive after turn abort");

      const retried = await sendToThread(h, sent.threadId, "mcp-durable: call");
      await waitThreadIdle(h, sent.threadId);
      expect(h.svc.threads.turnRow(retried.turnId)?.status).toBe("completed");
      const [originalPid, secondPid, ...otherPids] = (await readFile(launches, "utf8")).trim().split("\n").map(Number);
      expect(originalPid).toBe(firstPid);
      expect(otherPids).toEqual([]);
      expect(secondPid).not.toBe(firstPid);
      if (secondPid === undefined) throw new Error("MCP fixture did not reconnect after abort");
      expect(childAlive(secondPid)).toBe(true);
      await h.stop();
      expect(childAlive(secondPid)).toBe(false);
    });
  } finally {
    publisherFetch.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);

test("concurrent durable MCP calls refresh a publisher account once and use its new bearer token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-durable-account-"));
  const service = "service-fixture-github";
  const url = PLUGIN_PROVIDERS.github.services[0]!.mcpUrl!;
  const token = "fixture-refreshed-bearer";
  const staleToken = "fixture-stale-bearer";
  const { McpServer } = await import(Bun.resolveSync("@modelcontextprotocol/sdk/server/mcp.js", daemon));
  const { WebStandardStreamableHTTPServerTransport } = await import(Bun.resolveSync("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", daemon));
  const fixture = new McpServer({ name: "fixture", version: "1" });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: () => crypto.randomUUID() });
  fixture.registerTool("reflect", {}, ({ requestInfo }: { requestInfo?: { headers: { authorization?: string } } }) => ({
    content: [{ type: "text", text: `account: ${requestInfo?.headers.authorization}` }],
  }));
  const seen: (string | null)[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const authorization = request.headers.get("authorization");
    seen.push(authorization);
    return authorization === `Bearer ${token}` ? transport.handleRequest(request) : new Response(null, { status: 401 });
  } });
  const fetch = globalThis.fetch;
  let refreshCount = 0;
  const bothPreparing = Promise.withResolvers<void>();
  const publisherFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === url) return fetch(server.url, init);
    if (String(input) === `${publisher}/api/plugins/oauth/token`) {
      refreshCount++;
      expect(JSON.parse(String(init?.body))).toEqual({ providerId: "github", grantType: "refresh_token", refreshToken: "fixture-refresh" });
      await bothPreparing.promise;
      return Response.json({ access_token: token, expires_in: 3600 });
    }
    return fetch(input, init);
  }, { preconnect: fetch.preconnect }));
  try {
    await fixture.connect(transport);
    const plugins = path.join(root, "plugins");
    await mkdir(plugins);
    await writeFile(path.join(plugins, "configuration.json"), JSON.stringify({ version: 1, revision: 0, cloudUrl: publisher, mcp: [], skills: [], accounts: [{
      id: "fixture", providerId: "github", label: "Fixture", identity: "github:fixture", status: "connected", enabledServices: ["github"], nativeManaged: true,
      grant: { generation: "fixture", accessToken: staleToken, refreshToken: "fixture-refresh", expiresAt: Date.now() - 10_000, scopes: [], cloudUrl: publisher },
    }] }));
    await withDurableDaemon(root, async (h) => {
      h.svc.plugins.mcp.putService(service, { url }, { accountId: "fixture", serviceId: "github" });
      h.svc.plugins.mcp.setServiceToken(service, url, staleToken);
      const prepare = h.svc.plugins.prepareServiceCredentials.bind(h.svc.plugins);
      let preparing = 0;
      const preparation = spyOn(h.svc.plugins, "prepareServiceCredentials").mockImplementation(() => {
        if (++preparing === 2) bothPreparing.resolve();
        return prepare();
      });
      try {
        const bots = await Promise.all([makeBot(h, "MCP account one"), makeBot(h, "MCP account two")]);
        const turns = await Promise.all(bots.map((bot) => sendToBot(h, bot, "mcp-durable: account")));
        await Promise.all(turns.map(({ threadId }) => waitThreadIdle(h, threadId, 7_000)));
        expect(refreshCount).toBe(1);
        expect([...new Set(seen)]).toEqual([`Bearer ${token}`]);
        for (const { threadId, turnId } of turns) {
          expect(h.svc.threads.turnRow(turnId)?.status).toBe("completed");
          expect((await messages(h, threadId)).filter(({ kind }) => kind === "response").map(({ text }) => text)).toEqual(["account: [redacted]"]);
        }
      } finally {
        bothPreparing.resolve();
        preparation.mockRestore();
      }
    });
  } finally {
    publisherFetch.mockRestore();
    await server.stop(true);
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

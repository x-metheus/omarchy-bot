import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ToolResultEntry, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { PLUGIN_PROVIDERS } from "@omarchy-bot/protocol";
import { NativeMcpStore } from "../../plugins/nativeMcp.ts";
import { PluginsService } from "../../plugins/plugins.ts";
import { startOAuthMcpServer } from "../testing/oauthMcpServer.ts";
import { createMcpExtension, type McpExtensionDeps } from "./mcp.ts";

function expectSafeEqual(actual: unknown, expected: unknown) {
  expect(Bun.deepEquals(actual, expected)).toBe(true);
}

test("a scripted conversation searches, describes, and calls a local MCP server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-runtime-mcp-"));
  const daemon = path.resolve(import.meta.dir, "../../../..");
  const script = path.join(root, "server.ts");
  const launches = path.join(root, "launches.txt");
  let prefix = "echo";
  const inherited = process.env.OMARCHY_BOT_MCP_TEST_INHERITED;
  process.env.OMARCHY_BOT_MCP_TEST_INHERITED = "service-only";
  const storage = new MemoryStorage();
  const mcp = createMcpExtension({ servers: () => ({ revision: "fixture", secrets: [], servers: {
    local: { disabled: false, transport: { type: "stdio", command: process.execPath, args: [script, prefix] } },
    disabled: { disabled: true, transport: { type: "stdio", command: "unused", args: [] } },
    legacy: { disabled: false, transport: { type: "sse" } },
  } }) });
  let harness: Harness | undefined;
  try {
    await writeFile(script, `
import { appendFileSync } from "node:fs";
import { McpServer } from ${JSON.stringify(Bun.resolveSync("@modelcontextprotocol/sdk/server/mcp.js", daemon))};
import { StdioServerTransport } from ${JSON.stringify(Bun.resolveSync("@modelcontextprotocol/sdk/server/stdio.js", daemon))};
import { z } from ${JSON.stringify(Bun.resolveSync("zod", daemon))};
if (process.env.OMARCHY_BOT_MCP_TEST_INHERITED) throw new Error("Service environment leaked into child");
const prefix = process.argv[2];
appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ prefix, pid: process.pid }) + "\\n");
const server = new McpServer({ name: "local", version: "1" });
server.registerTool("repeat", { description: "Echo a message", inputSchema: { message: z.string() } }, async ({ message }) => ({
  content: [{ type: "text", text: \`\${prefix}: \${message}\` }],
  isError: message === "refused",
}));
await server.connect(new StdioServerTransport());
`);
    const provider = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
    const calls = [
      { action: "search", query: "echo" },
      { action: "describe", service: "local", tool: "repeat" },
      { action: "call", service: "local", tool: "repeat", arguments: { message: "hello" } },
      { action: "call", service: "local", tool: "repeat", arguments: { message: "refused" } },
      { action: "call", service: "local" },
      { action: "describe", service: "missing", tool: "repeat" },
      { action: "describe", service: "local", tool: "missing" },
      { action: "search", service: "disabled" },
      { action: "search", service: "legacy" },
    ];
    provider.setResponses([
      ...calls.map((args) => fauxAssistantMessage([fauxToolCall("mcp", args)], { stopReason: "toolUse" })),
      fauxAssistantMessage("Finished"),
    ]);
    const registry = createRegistry();
    registry.install(mcp);
    const models = createModels();
    models.setProvider(provider.provider);
    harness = await Harness.open(storage, { registry, models, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? root }) }, context);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await conversation.configure({ cwd: root, model: { provider: "fake", modelId: "fake-model" } }, context);
    async function childLaunches(): Promise<{ prefix: string; pid: number }[]> {
      return (await readFile(launches, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    }
    async function toolResults() {
      const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, context);
      return items.filter(ToolResultEntry.is).map((item) => {
        const result = item.model?.find((message) => message.role === "toolResult");
        if (!result || result.role !== "toolResult") throw new Error("Missing model tool result");
        return { isError: result.isError, text: result.content.map((content) => content.type === "text" ? content.text : "").join("\n") };
      });
    }
    expect(await Bun.file(launches).exists()).toBe(false);
    const submission = await conversation.submit({ type: "input", content: "Run the scripted MCP calls" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    const results = await toolResults();
    expect(results.map(({ isError }) => isError)).toEqual([false, false, false, true, true, true, true, true, true]);
    expect(results[0]?.text).toContain("local");
    expect(results[0]?.text).toContain("repeat");
    expect(results[0]?.text?.includes("Echo a message")).toBe(true);
    expect(results[1]?.text?.includes("Echo a message")).toBe(true);
    expect(JSON.parse(results[1]!.text).inputSchema).toMatchObject({
      type: "object", properties: { message: { type: "string" } }, required: ["message"],
    });
    expect(results[2]?.text).toBe("echo: hello");
    expect(results[3]?.text).toBe("echo: refused");
    expect(results[4]?.text).toMatch(/tool.*search/i);
    expect(results[5]?.text).toMatch(/missing.*search/i);
    expect(results[6]?.text).toMatch(/missing.*search/i);
    expect(results[7]?.text).toMatch(/disabled/i);
    expect(results[8]?.text).toMatch(/sse.*unsupported|unsupported.*sse/i);
    expect((await childLaunches()).map((child) => child.prefix)).toEqual(["echo"]);

    prefix = "updated";
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall("mcp", { action: "call", service: "local", tool: "repeat", arguments: { message: "hello" } })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished"),
    ]);
    const retry = await conversation.submit({ type: "input", content: "Call the updated MCP server" }, context);
    expect((await retry.wait(context)).status).toBe("done");
    expect((await toolResults()).at(-1)).toEqual({ isError: false, text: "updated: hello" });
    const children = await childLaunches();
    expect(children.map((child) => child.prefix)).toEqual(["echo", "updated"]);
    expect(new Set(children.map((child) => child.pid)).size).toBe(2);
    await mcp.close();
    for (const { pid } of children) {
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid MCP fixture PID");
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally {
    try { await mcp.close(); }
    finally {
      if (inherited === undefined) delete process.env.OMARCHY_BOT_MCP_TEST_INHERITED;
      else process.env.OMARCHY_BOT_MCP_TEST_INHERITED = inherited;
      await harness?.close(context);
      await storage.close(context);
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function writeStdioFixture(root: string, source: string): Promise<string> {
  const script = path.join(root, "server.ts");
  const daemon = path.resolve(import.meta.dir, "../../../..");
  await writeFile(script, `
import { writeFileSync } from "node:fs";
import { McpServer } from ${JSON.stringify(Bun.resolveSync("@modelcontextprotocol/sdk/server/mcp.js", daemon))};
import { StdioServerTransport } from ${JSON.stringify(Bun.resolveSync("@modelcontextprotocol/sdk/server/stdio.js", daemon))};
import { z } from ${JSON.stringify(Bun.resolveSync("zod", daemon))};
const server = new McpServer({ name: "fixture", version: "1" });
${source}
`);
  return script;
}

function localServer(script: string): McpExtensionDeps["servers"] {
  return () => ({ revision: "fixture", secrets: [], servers: {
    local: { disabled: false, transport: { type: "stdio", command: process.execPath, args: [script] } },
  } });
}

function executeMcp(mcp: ReturnType<typeof createMcpExtension>, input: object, ctx = context) {
  return mcp.tools![0]!.execute(input, {} as ToolExecutionApi, ctx);
}

async function waitForFile(file: string): Promise<string> {
  const deadline = AbortSignal.timeout(2_000);
  while (!await Bun.file(file).exists()) {
    deadline.throwIfAborted();
    await Bun.sleep(10);
  }
  return readFile(file, "utf8");
}

test("MCP discovery and call results redact stdio credentials in the durable transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-redaction-"));
  const secret = 'fixture-"private"-\\value';
  const bearer = "fixture-account-token";
  const storage = new MemoryStorage();
  let mcp: ReturnType<typeof createMcpExtension> | undefined;
  let harness: Harness | undefined;
  try {
    const script = await writeStdioFixture(root, `
server.registerTool("reflect", {
  description: \`Fixture description: \${process.env.SECRET}, \${process.env.SHORT_KEY}, \${process.env.MODE}, ${bearer}\`,
  inputSchema: { fail: z.boolean().describe(\`Mode: \${process.env.MODE}; key: \${process.env.SHORT_KEY}\`), q7: z.string().optional() },
}, ({ fail }) => ({
  content: [{ type: "text", text: \`Fixture result: \${process.env.SECRET}, \${process.env.SECRET}, \${process.env.SHORT_KEY}, ${bearer}\` }],
  isError: fail,
}));
server.registerTool("reflect_json", {}, () => ({
  content: [
    { type: "text", text: [
      "{",
      '  "2": 9007199254740993,',
      '  "1": ' + process.env.NUMERIC_SECRET + ",",
      '  "nested": [' + JSON.stringify(process.env.SECRET) + ', "visible"],',
      '  "mode": "MODE=' + process.env.MODE + '"',
      "}",
    ].join("\\n") },
    { type: "text", text: JSON.stringify("Fixture result: " + process.env.SECRET) },
    { type: "text", text: "Escaped fragment: " + JSON.stringify(process.env.SECRET).slice(1, -1) },
  ],
}));
await server.connect(new StdioServerTransport());
`);
    const privateDir = path.join(root, "private");
    const url = "https://account.example/mcp";
    await mkdir(privateDir);
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [script], env: { SECRET: secret, SHORT_KEY: "q7", NUMERIC_SECRET: "123456", MODE: "type" } },
      account: { url },
    } }));
    await writeFile(path.join(privateDir, "native-mcp.json"), JSON.stringify({ version: 1, entries: {
      account: { id: "account", pi: null, codex: null, owner: { accountId: "account-id", serviceId: "service-id" } },
    }, serviceTokens: { account: { url, token: bearer } } }));
    const store = new NativeMcpStore(root, privateDir);
    mcp = createMcpExtension({ servers: () => store.effectiveServers() });
    const calls = [
      { action: "search", service: "local" },
      { action: "describe", service: "local", tool: "reflect" },
      { action: "call", service: "local", tool: "reflect", arguments: { fail: false } },
      { action: "call", service: "local", tool: "reflect", arguments: { fail: true } },
      { action: "call", service: "local", tool: "reflect_json" },
    ];
    const provider = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
    provider.setResponses([
      ...calls.map((args) => fauxAssistantMessage([fauxToolCall("mcp", args)], { stopReason: "toolUse" })),
      fauxAssistantMessage("Finished"),
    ]);
    const registry = createRegistry();
    registry.install(mcp);
    const models = createModels();
    models.setProvider(provider.provider);
    harness = await Harness.open(storage, { registry, models }, context);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await conversation.configure({ cwd: root, model: { provider: "fake", modelId: "fake-model" } }, context);
    const submission = await conversation.submit({ type: "input", content: "Run the scripted MCP calls" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const results = items.filter(ToolResultEntry.is).flatMap(({ model }) => model ?? []).filter((message) => message.role === "toolResult");
    expect(results.map(({ isError }) => isError)).toEqual([false, false, false, true, false]);
    const texts = results.map(({ content }) => content.map((item) => item.type === "text" ? item.text : "").join("\n"));
    const description = "Fixture description: [redacted], [redacted], type, [redacted]";
    expect(JSON.parse(texts[0]!).services[0].tools[0].description === description).toBe(true);
    const described = JSON.parse(texts[1]!);
    expect(described.description === description).toBe(true);
    const schema = described.inputSchema;
    expect(schema?.type === "object" && schema?.properties?.fail?.type === "boolean" &&
      schema?.properties?.fail?.description === "Mode: type; key: [redacted]" && schema?.properties?.q7?.type === "string").toBe(true);
    expectSafeEqual(texts.slice(2, 4), Array(2).fill("Fixture result: [redacted], [redacted], [redacted], [redacted]"));
    const jsonTexts = results[4]!.content.flatMap((item) => item.type === "text" ? [item.text] : []);
    expectSafeEqual(jsonTexts, [
      `{
  "2": 9007199254740993,
  "1": [redacted],
  "nested": ["[redacted]", "visible"],
  "mode": "MODE=type"
}`,
      '"Fixture result: [redacted]"',
      "Escaped fragment: [redacted]",
    ]);
    const transcript = JSON.stringify(items);
    expect(transcript.includes("fixture-")).toBe(false);
  } finally {
    await mcp?.close();
    await harness?.close(context);
    await storage.close(context);
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP searches, describes, and calls an authenticated Streamable HTTP service and closes its session", async () => {
  const daemon = path.resolve(import.meta.dir, "../../../..");
  const sdk = await import(Bun.resolveSync("@modelcontextprotocol/sdk/server/mcp.js", daemon)) as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
  const http = await import(Bun.resolveSync("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", daemon)) as typeof import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
  const token = "fixture-service-account-bearer";
  const sessionId = crypto.randomUUID();
  const observedAuthorization: (string | null)[] = [];
  const rejectedRequests: string[] = [];
  const closedSessions: string[] = [];
  const fixture = new sdk.McpServer({ name: "fixture", version: "1" });
  const transport = new http.WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessionclosed: (id) => { closedSessions.push(id); },
    enableJsonResponse: true,
  });
  fixture.registerTool("reflect", { description: "Reflect service authorization", inputSchema: {} }, (_args, { requestInfo }) => {
    const authorization = String(requestInfo?.headers.authorization);
    return { content: [{ type: "text", text: `Header: ${authorization}; token: ${authorization.slice("Bearer ".length)}` }] };
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/account") {
      const authorization = request.headers.get("authorization");
      observedAuthorization.push(authorization);
      if (authorization === `Bearer ${token}`) return transport.handleRequest(request);
    } else {
      rejectedRequests.push(`${request.method} ${pathname}`);
    }
    return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", request.url)}"` } });
  } });
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-http-"));
  const store = new NativeMcpStore(root, path.join(root, "private"));
  const mcp = createMcpExtension({ servers: () => store.effectiveServers() });
  try {
    await fixture.connect(transport);
    const url = new URL("/account", server.url).href;
    store.putService("account", { url }, { accountId: "fixture-account", serviceId: "fixture-service" });
    store.setServiceToken("account", url, token);
    store.save(null, { name: "consent", enabled: true, transport: { type: "http", url: new URL("/consent", server.url).href } });

    const search = await executeMcp(mcp, { action: "search", service: "account", query: "authorization" });
    expect(search.isError).toBe(false);
    expectSafeEqual(search.output, [{ type: "text", text: JSON.stringify({ services: [{ service: "account", tools: [{ name: "reflect", description: "Reflect service authorization" }] }] }, null, 2) }]);
    const describe = await executeMcp(mcp, { action: "describe", service: "account", tool: "reflect" });
    expect(describe.isError).toBe(false);
    const metadata = describe.output?.[0];
    const described = JSON.parse(metadata?.type === "text" ? metadata.text : "null");
    expect(described?.service === "account" && described?.tool === "reflect" &&
      described?.description === "Reflect service authorization" && described?.inputSchema?.type === "object").toBe(true);
    const properties = described?.inputSchema?.properties;
    expect(properties !== null && typeof properties === "object" && !Array.isArray(properties)).toBe(true);
    const call = await executeMcp(mcp, { action: "call", service: "account", tool: "reflect", arguments: {} });
    expectSafeEqual(call, { isError: false, output: [{ type: "text", text: "Header: [redacted]; token: [redacted]" }] });

    const unauthorized = await executeMcp(mcp, { action: "search", service: "consent" });
    expect(unauthorized).toEqual({ isError: true, output: [{ type: "text", text: expect.stringMatching(/consent.*needs sign-in/) }] });
    expect(rejectedRequests).toEqual(["POST /consent"]);
    const configurationRevision = store.effectiveServers().revision;
    expect(mcp.status()).toEqual([
      { name: "account", configurationRevision, status: "connected", toolCount: 1, disabled: false },
      { name: "consent", configurationRevision, status: "needs-auth", toolCount: 0, disabled: false },
    ]);
    expect(transport.sessionId === sessionId).toBe(true);
    expectSafeEqual(closedSessions, []);
    await mcp.close();
    expectSafeEqual(closedSessions, [sessionId]);
    expectSafeEqual([...new Set(observedAuthorization)], [`Bearer ${token}`]);
  } finally {
    await mcp.close();
    await server.stop(true);
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP passes the HTTP URL to its auth provider and maps OAuth challenges to needs-auth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-auth-provider-"));
  let needsAuth = true;
  const fixture = new McpServer({ name: "fixture", version: "1" });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: () => crypto.randomUUID() });
  fixture.registerTool("read", {}, () => ({ content: [{ type: "text", text: "read" }] }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return needsAuth ? new Response(null, { status: 401 }) : transport.handleRequest(request);
  } });
  const url = new URL("/mcp", server.url).href;
  const providerCalls: string[][] = [];
  const store = new NativeMcpStore(root, path.join(root, "private"));
  const mcp = createMcpExtension({ servers: () => store.effectiveServers(), authProvider(service, resolvedUrl) {
    providerCalls.push([service, resolvedUrl]);
    return { async token() { return undefined; }, onUnauthorized() { throw new McpOAuthAuthorizationRequiredError(); } };
  } });
  try {
    await fixture.connect(transport);
    const script = await writeStdioFixture(root, `
server.registerTool("local_read", {}, () => ({ content: [{ type: "text", text: "read" }] }));
await server.connect(new StdioServerTransport());
`);
    store.save(null, { name: "local", enabled: true, transport: { type: "stdio", command: process.execPath, args: [script] } });
    store.save(null, { name: "remote", enabled: true, transport: { type: "http", url } });
    expect((await executeMcp(mcp, { action: "search", service: "local" })).isError).toBe(false);
    expect((await executeMcp(mcp, { action: "search", service: "remote" })).isError).toBe(true);
    expectSafeEqual(providerCalls, [["remote", url]]);
    expect(mcp.status().find(({ name }) => name === "remote")?.status).toBe("needs-auth");

    needsAuth = false;
    expect(await mcp.check("remote")).toMatchObject({ status: "connected", toolCount: 1 });
    needsAuth = true;
    const call = await executeMcp(mcp, { action: "call", service: "remote", tool: "read" });
    expectSafeEqual(call, { isError: true, output: [{
      type: "text", text: 'MCP service "remote" needs sign-in. Sign in through Services and retry.',
    }] });
    expect(mcp.status().find(({ name }) => name === "remote")?.status).toBe("needs-auth");
    expect(await mcp.check("missing")).toBeUndefined();
    await server.stop(true);
    expect(await mcp.check("remote")).toMatchObject({ status: "failed", toolCount: 0 });
  } finally {
    await mcp.close();
    await server.stop(true);
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP check reports stdio status without spawning or replacing the process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-check-"));
  const launches = path.join(root, "launches");
  const script = await writeStdioFixture(root, `
writeFileSync(${JSON.stringify(launches)}, String(process.pid) + "\\n", { flag: "a" });
server.registerTool("pid", {}, () => ({ content: [{ type: "text", text: String(process.pid) }] }));
await server.connect(new StdioServerTransport());
`);
  const mcp = createMcpExtension({ servers: localServer(script) });
  const getPid = async () => {
    const result = await mcp.tools![0]!.execute({ action: "call", service: "local", tool: "pid" },
      { ...({} as ToolExecutionApi), env: new NodeExecutionEnv({ cwd: root }) }, context);
    const part = result.output?.[0];
    return Number(part?.type === "text" ? part.text : NaN);
  };
  try {
    expect(await mcp.check("local")).toMatchObject({ status: "not-connected", toolCount: 0 });
    expect(await Bun.file(launches).exists()).toBe(false);
    const first = await getPid();
    expect(first).toBeGreaterThan(1);
    expect(await mcp.check("local", root)).toMatchObject({ status: "connected", toolCount: 1 });
    const second = await getPid();
    expect(second).toBeGreaterThan(1);
    expect(second).toBe(first);
    expect(() => process.kill(first, 0)).not.toThrow();
    expect(await readFile(launches, "utf8")).toBe(`${first}\n`);
    await mcp.close();
    expect(() => process.kill(second, 0)).toThrow();
  } finally {
    await mcp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP status follows the bounded configuration snapshot and reports failed discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-status-"));
  const store = new NativeMcpStore(root, path.join(root, "private"));
  const mcp = createMcpExtension({ servers: () => store.effectiveServers() });
  try {
    const script = await writeStdioFixture(root, `
server.registerTool("run", {}, () => ({ content: [{ type: "text", text: "finished" }] }));
await server.connect(new StdioServerTransport());
`);
    const local = store.save(null, { name: "local", enabled: true, transport: { type: "stdio", command: process.execPath, args: [script] } });
    store.save(null, { name: "broken", enabled: true, transport: { type: "stdio", command: path.join(root, "missing"), args: [] } });
    store.save(null, { name: "off", enabled: false, transport: { type: "stdio", command: "unlaunched", args: [] } });
    const initialRevision = store.effectiveServers().revision;
    expect(mcp.status()).toEqual([
      { name: "local", configurationRevision: initialRevision, status: "not-connected", toolCount: 0, disabled: false },
      { name: "broken", configurationRevision: initialRevision, status: "not-connected", toolCount: 0, disabled: false },
      { name: "off", configurationRevision: initialRevision, status: "disabled", toolCount: 0, disabled: true },
    ]);
    const result = await executeMcp(mcp, { action: "search" });
    expect(result.isError).toBe(false);
    expect(mcp.status()).toEqual([
      { name: "local", configurationRevision: initialRevision, status: "connected", toolCount: 1, disabled: false },
      { name: "broken", configurationRevision: initialRevision, status: "failed", toolCount: 0, disabled: false },
      { name: "off", configurationRevision: initialRevision, status: "disabled", toolCount: 0, disabled: true },
    ]);
    store.updateStatus(mcp.status());
    expect(store.list().find(({ name }) => name === "local")).toMatchObject({ status: "connected", toolCount: 1, pendingReload: false });

    store.save(local.id, { name: "local", enabled: true, transport: { type: "stdio", command: process.execPath, args: [script, "edited"] } });
    const editedRevision = store.effectiveServers().revision;
    expect(editedRevision).not.toBe(initialRevision);
    expect(mcp.status().find(({ name }) => name === "local")).toEqual({
      name: "local", configurationRevision: editedRevision, status: "not-connected", toolCount: 0, disabled: false,
    });
  } finally {
    await mcp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable MCP credential preparation rejects a workspace FIFO without blocking", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-credential-fifo-"));
  const workspace = path.join(root, "workspace");
  const privateDir = path.join(root, "private");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await mkdir(workspace);
    await mkdir(privateDir);
    await writeFile(path.join(privateDir, "configuration.json"), JSON.stringify({ version: 1, revision: 0, cloudUrl: null, mcp: [], skills: [], accounts: [{
      id: "fixture", providerId: "github", label: "Fixture", identity: "github:fixture", status: "connected",
      enabledServices: ["github"], nativeManaged: true, grant: {
        generation: "fixture", accessToken: "fixture-publisher-credential", scopes: [], cloudUrl: "https://publisher.invalid",
      },
    }] }));
    expect(Bun.spawnSync(["mkfifo", path.join(workspace, ".mcp.json")]).exitCode).toBe(0);
    const child = Bun.spawn([process.execPath, "--eval", `
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PluginsService } from ${JSON.stringify(new URL("../../plugins/plugins.ts", import.meta.url).href)};
import { createMcpExtension } from ${JSON.stringify(new URL("./mcp.ts", import.meta.url).href)};
const plugins = new PluginsService(${JSON.stringify(privateDir)}, ${JSON.stringify(workspace)}, async () => ({ skills: [] }));
const servers = () => plugins.mcp.effectiveServers();
const mcp = createMcpExtension({ servers, async prepareServers() {
  await plugins.prepareServiceCredentials();
  return servers();
} });
try {
  console.log(JSON.stringify(await mcp.tools[0].execute({ action: "search" }, {}, BACKGROUND_CONTEXT)));
} finally {
  await mcp.close();
  await plugins.shutdown();
}
`], { cwd: path.resolve(import.meta.dir, "../../../.."), stdout: "pipe", stderr: "inherit" });
    try {
      const [stdout, code] = await Promise.race([
        Promise.all([new Response(child.stdout).text(), child.exited]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Durable MCP blocked in credential preparation on a workspace FIFO")), 2_000);
        }),
      ]);
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ isError: true, output: [{ type: "text", text: expect.stringMatching(/MCP configuration.*\.mcp\.json.*regular file/) }] });
      expect(stdout.includes(root)).toBe(false);
      expect(stdout.includes("fixture-publisher-credential")).toBe(false);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP redacts quoted and unquoted cookie values echoed by an HTTP tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-cookie-"));
  const store = new NativeMcpStore(root, path.join(root, "private"));
  const mcp = createMcpExtension({ servers: () => store.effectiveServers() });
  const fixture = new McpServer({ name: "fixture", version: "1" });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: () => crypto.randomUUID() });
  fixture.registerTool("read_session", {}, ({ requestInfo }) => {
    const session = String(requestInfo?.headers.cookie).match(/^session=([^;]+)/)?.[1];
    return { content: [
      { type: "text", text: `Session: ${session}` },
      { type: "text", text: `Decoded session: ${session?.slice(1, -1)}` },
    ] };
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => transport.handleRequest(request) });
  try {
    await fixture.connect(transport);
    store.save(null, {
      name: "remote", enabled: true,
      transport: { type: "http", url: server.url.href, headers: { Cookie: 'session="abc123"; theme=fixture-theme' } },
    });
    const result = await executeMcp(mcp, { action: "call", service: "remote", tool: "read_session" });
    expect(result.isError).toBe(false);
    expectSafeEqual(result.output, [
      { type: "text", text: "Session: [redacted]" },
      { type: "text", text: "Decoded session: [redacted]" },
    ]);
  } finally {
    try { await mcp.close(); }
    finally {
      await server.stop(true);
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("MCP search returns usable identifiers, matches redacted descriptions, and sanitizes errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-search-"));
  const secret = "fixture-hidden-search-term";
  const identifierSecret = "fixture-identifier";
  const serviceName = `local-${identifierSecret}`;
  const toolName = `lookup-${identifierSecret}`;
  const broken = `unavailable-${secret}`;
  let mcp: ReturnType<typeof createMcpExtension> | undefined;
  try {
    const script = await writeStdioFixture(root, `
server.registerTool(${JSON.stringify(toolName)}, { description: "Visible description ${secret}" }, () => ({
  content: [{ type: "text", text: "found" }],
}));
await server.connect(new StdioServerTransport());
`);
    mcp = createMcpExtension({ servers: () => {
      const local = localServer(script)();
      return { ...local, secrets: [secret, identifierSecret], servers: {
        [serviceName]: local.servers.local!,
        [broken]: { disabled: false, transport: { type: "stdio", command: path.join(root, "missing-executable"), args: [] } },
      } };
    } });
    const hidden = await executeMcp(mcp, { action: "search", service: serviceName, query: secret });
    expect(hidden.output).toEqual([{ type: "text", text: JSON.stringify({ services: [] }, null, 2) }]);

    const visible = await executeMcp(mcp, { action: "search", query: "visible description" });
    expect(visible.isError).toBe(false);
    const output = visible.output?.[0];
    const found = JSON.parse(output?.type === "text" ? output.text : "") as {
      services: { service: string; tools: { name: string; description: string }[] }[];
      errors: string[];
    };
    const { service, tools } = found.services[0]!;
    const tool = tools[0]!.name;
    const describe = await executeMcp(mcp, { action: "describe", service, tool });
    expect(describe.isError).toBe(false);
    const metadata = describe.output?.[0];
    const described = JSON.parse(metadata?.type === "text" ? metadata.text : "null");
    expect(described?.service === serviceName && described?.tool === toolName &&
      described?.description === "Visible description [redacted]").toBe(true);
    const call = await executeMcp(mcp, { action: "call", service, tool });
    expect(call.isError).toBe(false);
    expect(call.output).toEqual([{ type: "text", text: "found" }]);
    const searchError = found.errors?.[0] ?? "";
    expectSafeEqual(found, {
      services: [{ service: serviceName, tools: [{ name: toolName, description: "Visible description [redacted]" }] }],
      errors: [searchError],
    });
    expect(/unavailable-\[redacted\].*failed/.test(searchError)).toBe(true);

    const failed = await executeMcp(mcp, { action: "search", service: broken });
    expect(failed.isError).toBe(true);
    expect(failed.output).toEqual([{ type: "text", text: expect.stringMatching(/unavailable-\[redacted\].*failed/) }]);
  } finally {
    await mcp?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting a stdio MCP call lets the next call reconnect and finish", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-abort-"));
  const started = path.join(root, "started");
  let mcp: ReturnType<typeof createMcpExtension> | undefined;
  const abort = new AbortController();
  try {
    const script = await writeStdioFixture(root, `
server.registerTool("sleep", { inputSchema: { first: z.boolean() } }, async ({ first }) => {
  if (first) writeFileSync(${JSON.stringify(started)}, String(process.pid));
  await Bun.sleep(first ? 3_000 : 250);
  return { content: [{ type: "text", text: first ? "first" : String(process.pid) }] };
});
await server.connect(new StdioServerTransport());
`);
    mcp = createMcpExtension({ servers: localServer(script) });
    const call = { action: "call", service: "local", tool: "sleep" };
    const first = executeMcp(mcp, { ...call, arguments: { first: true } }, withAbortSignal(abort.signal, context));
    const firstPid = Number(await waitForFile(started));
    const second = executeMcp(mcp, { ...call, arguments: { first: false } });
    await Bun.sleep(30);
    abort.abort(new Error("cancel first call"));
    await expect(first).rejects.toThrow("cancel first call");
    const result = await second;
    expect(result.isError).toBe(false);
    const output = result.output?.[0];
    const secondPid = Number(output?.type === "text" ? output.text : NaN);
    expect(secondPid).toBeGreaterThan(1);
    expect(secondPid).not.toBe(firstPid);
    expect(() => process.kill(firstPid, 0)).toThrow();
  } finally {
    await mcp?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a queued MCP call refuses a service disabled while it was waiting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-disabled-queue-"));
  const started = path.join(root, "started");
  const launches = path.join(root, "launches");
  const abort = new AbortController();
  let mcp: ReturnType<typeof createMcpExtension> | undefined;
  try {
    const script = await writeStdioFixture(root, `
writeFileSync(${JSON.stringify(launches)}, String(process.pid) + "\\n", { flag: "a" });
server.registerTool("sleep", { inputSchema: { first: z.boolean() } }, async ({ first }) => {
  if (first) {
    writeFileSync(${JSON.stringify(started)}, String(process.pid));
    await Bun.sleep(3_000);
  }
  return { content: [{ type: "text", text: "finished" }] };
});
await server.connect(new StdioServerTransport());
`);
    const store = new NativeMcpStore(root, path.join(root, "private"));
    const service = store.save(null, { name: "local", enabled: true, transport: { type: "stdio", command: process.execPath, args: [script] } });
    mcp = createMcpExtension({ servers: () => store.effectiveServers() });
    const call = { action: "call", service: "local", tool: "sleep" };
    const first = executeMcp(mcp, { ...call, arguments: { first: true } }, withAbortSignal(abort.signal, context));
    const firstPid = await waitForFile(started);
    const queued = executeMcp(mcp, { ...call, arguments: { first: false } });
    const queuedDescribe = executeMcp(mcp, { ...call, action: "describe" });
    store.enable(service.id, false);
    abort.abort(new Error("release the active call"));

    await expect(first).rejects.toThrow("release the active call");
    for (const result of await Promise.all([queued, queuedDescribe])) {
      expect(result.isError).toBe(true);
      expect(result.output).toEqual([{ type: "text", text: expect.stringMatching(/local.*disabled/i) }]);
    }
    expect(await readFile(launches, "utf8")).toBe(`${firstPid}\n`);
  } finally {
    await mcp?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["disabled", "changed", "removed"] as const)("a queued MCP call refuses a service %s while waiting for transport close", async (change) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-closing-queue-"));
  const launches = path.join(root, "launches");
  const closeStarted = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  const close = StdioTransport.prototype.close;
  const closeMock = spyOn(StdioTransport.prototype, "close").mockImplementation(async function (this: StdioTransport) {
    await close.call(this);
    closeStarted.resolve();
    await releaseClose.promise;
  });
  let mcp: ReturnType<typeof createMcpExtension> | undefined;
  try {
    const script = await writeStdioFixture(root, `
writeFileSync(${JSON.stringify(launches)}, process.argv[2] + "\\n", { flag: "a" });
server.registerTool("run", {}, () => ({ content: [{ type: "text", text: "finished" }] }));
await server.connect(new StdioServerTransport());
`);
    const store = new NativeMcpStore(root, path.join(root, "private"));
    const save = (id: string | null, version: string) => store.save(id, {
      name: "local", enabled: true, transport: { type: "stdio", command: process.execPath, args: [script, version] },
    });
    const { id } = save(null, "initial");
    mcp = createMcpExtension({ servers: () => store.effectiveServers() });
    const call = { action: "call", service: "local", tool: "run" };
    expect((await executeMcp(mcp, call)).isError).toBe(false);
    save(id, "replacement");
    const queued = executeMcp(mcp, call);
    await Promise.race([closeStarted.promise, queued.then(() => { throw new Error("MCP call completed before transport close"); })]);
    if (change === "disabled") store.enable(id, false);
    else if (change === "changed") save(id, "changed again");
    else store.remove(id);
    releaseClose.resolve();

    const result = await queued;
    expect(result.isError).toBe(true);
    const message = change === "removed" ? /local.*no longer configured/i : new RegExp(`local.*${change}`, "i");
    expect(result.output).toEqual([{ type: "text", text: expect.stringMatching(message) }]);
    expect(await readFile(launches, "utf8")).toBe("initial\n");
  } finally {
    releaseClose.resolve();
    try { await mcp?.close(); }
    finally {
      closeMock.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a timed-out stdio MCP call reports its limit and kills the child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-timeout-"));
  const started = path.join(root, "started");
  const timeoutMs = 100;
  let mcp: ReturnType<typeof createMcpExtension> | undefined;
  try {
    const script = await writeStdioFixture(root, `
setInterval(() => {}, 1_000);
server.registerTool("sleep", {}, async () => {
  writeFileSync(${JSON.stringify(started)}, String(process.pid));
  await Bun.sleep(1_500);
  return { content: [{ type: "text", text: "finished sleeping" }] };
});
await server.connect(new StdioServerTransport());
`);
    const deps = { servers: localServer(script), callTimeoutMs: timeoutMs };
    mcp = createMcpExtension(deps);
    const result = await executeMcp(mcp, { action: "call", service: "local", tool: "sleep" });
    const pid = Number(await readFile(started, "utf8"));
    expect(result.isError).toBe(true);
    expect(result.output).toEqual([{ type: "text", text: expect.stringMatching(/timed out.*100 ms/) }]);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await mcp?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["request timeout", "invocation deadline"] as const)("a timed-out HTTP MCP call reconnects after %s", async (limit) => {
  let handshakes = 0;
  const started = Promise.withResolvers<AbortSignal>();
  const replyToRequest = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const { id, method, params } = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        handshakes++;
        return reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
      case "notifications/initialized":
      case "notifications/cancelled":
        return new Response(null, { status: 202 });
      case "tools/list":
        return reply({ tools: [{ name: "wait", inputSchema: { type: "object" } }] });
      case "tools/call": {
        if (!params.arguments.slow) return reply({ content: [{ type: "text", text: `connection ${handshakes}` }] });
        const signal = init?.signal;
        if (!signal) throw new Error("Missing HTTP transport signal");
        started.resolve(signal);
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      default:
        throw new Error(`Unexpected MCP method ${method}`);
    }
  };
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(replyToRequest, { preconnect: () => {} }));
  const mcp = createMcpExtension({ callTimeoutMs: limit === "request timeout" ? 50 : 1_000, servers: () => ({
    revision: "fixture", secrets: [], servers: { remote: { disabled: false, transport: { type: "http", url: "https://fixture.example/mcp" } } },
  }) });
  try {
    const call = { action: "call", service: "remote", tool: "wait" };
    const abort = new AbortController();
    const first = executeMcp(mcp, { ...call, arguments: { slow: true } }, withAbortSignal(abort.signal, context));
    const signal = await Promise.race([started.promise, first.then(() => {
      throw new Error("MCP call completed before the HTTP request started");
    })]);
    if (limit === "invocation deadline") {
      abort.abort(new DOMException("Fixture deadline exceeded", "TimeoutError"));
      await expect(first).rejects.toThrow("Fixture deadline exceeded");
    } else {
      const result = await first;
      expect(result.isError).toBe(true);
      expect(result.output).toEqual([{ type: "text", text: expect.stringMatching(/timed out.*50 ms/) }]);
    }
    const next = await executeMcp(mcp, { ...call, arguments: { slow: false } });
    expect(next.output).toEqual([{ type: "text", text: "connection 2" }]);
    expect(next.isError).toBe(false);
    expect(signal.aborted).toBe(true);
  } finally {
    try { await mcp.close(); }
    finally { fetchMock.mockRestore(); }
  }
});

test("MCP shutdown drains publisher credential preparation after a call is aborted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-close-preparation-"));
  const privateDir = path.join(root, "private");
  const publisher = "https://publisher.invalid";
  const tokenEndpoint = `${publisher}/api/plugins/oauth/token`;
  const service = "service-fixture-github";
  const url = PLUGIN_PROVIDERS.github.services[0]!.mcpUrl!;
  const staleToken = "fixture-stale-bearer";
  const refreshedToken = "fixture-refreshed-bearer";
  const publisherStarted = Promise.withResolvers<void>();
  const releasePublisher = Promise.withResolvers<void>();
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    if (String(input) !== tokenEndpoint) throw new Error("Unexpected request during credential preparation.");
    publisherStarted.resolve();
    await releasePublisher.promise;
    return Response.json({ access_token: refreshedToken, expires_in: 3600 });
  }, { preconnect: fetch.preconnect }));
  let plugins: PluginsService | undefined;
  let mcp: ReturnType<typeof createMcpExtension> | undefined;
  const preparations: Promise<void>[] = [];
  try {
    await mkdir(privateDir);
    await writeFile(path.join(privateDir, "configuration.json"), JSON.stringify({ version: 1, revision: 0, cloudUrl: publisher, mcp: [], skills: [], accounts: [{
      id: "fixture", providerId: "github", label: "Fixture", identity: "github:fixture", status: "connected", enabledServices: ["github"], nativeManaged: true,
      grant: { generation: "fixture", accessToken: staleToken, refreshToken: "fixture-refresh", expiresAt: Date.now() - 10_000, scopes: [], cloudUrl: publisher },
    }] }));
    const servicePlugins = plugins = new PluginsService(privateDir, root, async () => ({ skills: [] }));
    servicePlugins.mcp.putService(service, { url }, { accountId: "fixture", serviceId: "github" });
    servicePlugins.mcp.setServiceToken(service, url, staleToken);
    const servers = () => servicePlugins.mcp.effectiveServers();
    mcp = createMcpExtension({ servers, async prepareServers() {
      const preparation = servicePlugins.prepareServiceCredentials();
      preparations.push(preparation);
      await preparation;
      return servers();
    } });

    const input = { action: "call", service, tool: "run" };
    const abort = new AbortController();
    const call = executeMcp(mcp, input, withAbortSignal(abort.signal, context));
    await Promise.race([publisherStarted.promise, call.then(() => { throw new Error("MCP call completed before publisher refresh"); })]);
    abort.abort(new Error("cancel MCP call"));
    await expect(call).rejects.toThrow("cancel MCP call");

    let closed = false;
    const closing = mcp.close().then(() => { closed = true; });
    expect(await executeMcp(mcp, input)).toEqual({ isError: true, output: [{ type: "text", text: expect.stringMatching(/shutting down/i) }] });
    expect(preparations).toHaveLength(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(servers().secrets.includes(staleToken)).toBe(true);

    releasePublisher.resolve();
    await closing;
    expect(servers().secrets.includes(refreshedToken)).toBe(true);
    expectSafeEqual(fetchMock.mock.calls.map(([input]) => String(input)), [tokenEndpoint]);
  } finally {
    releasePublisher.resolve();
    await Promise.allSettled(preparations);
    try {
      await mcp?.close();
      await plugins?.shutdown();
    } finally {
      fetchMock.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("MCP shutdown waits for a failed handshake's child to exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-handshake-"));
  const closing = path.join(root, "closing");
  let mcp: ReturnType<typeof createMcpExtension> | undefined;
  try {
    const script = await writeStdioFixture(root, `
process.stdin.once("data", (data) => {
  const { id } = JSON.parse(String(data));
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "failed" } }) + "\\n");
});
process.stdin.on("end", () => writeFileSync(${JSON.stringify(closing)}, String(process.pid)));
setInterval(() => {}, 1_000);
`);
    mcp = createMcpExtension({ servers: localServer(script) });
    const call = executeMcp(mcp, { action: "call", service: "local", tool: "unavailable" });
    const pid = Number(await waitForFile(closing));
    await mcp.close();
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await call).isError).toBe(true);
  } finally {
    await mcp?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP reports a shared deletion conflict while another service remains callable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-deletion-conflict-"));
  const shared = path.join(root, ".mcp.json");
  const pi = path.join(root, ".pi", "mcp.json");
  const secret = "fixture-conflict-key";
  let mcp: ReturnType<typeof createMcpExtension> | undefined;
  try {
    const script = await writeStdioFixture(root, `
server.registerTool("run", {}, () => ({ content: [{ type: "text", text: "finished" }] }));
await server.connect(new StdioServerTransport());
`);
    const definition = { command: process.execPath, args: [script] };
    await mkdir(path.dirname(pi));
    await writeFile(shared, JSON.stringify({ mcpServers: { local: definition, other: definition } }));
    await writeFile(pi, JSON.stringify({ mcpServers: { local: definition } }));
    const store = new NativeMcpStore(root, path.join(root, "private"));
    expect(store.list().find(({ name }) => name === "local")?.status).not.toBe("conflict");

    await writeFile(shared, JSON.stringify({ mcpServers: { other: definition } }));
    await writeFile(pi, JSON.stringify({ mcpServers: { local: { ...definition, env: { API_KEY: secret } } } }));
    const effective = store.effectiveServers();
    expect(store.list().find(({ name }) => name === "local")).toMatchObject({
      status: "conflict", error: expect.stringMatching(/deletion conflicts/i),
    });
    expect(effective.configurationError).toBeUndefined();
    expect(effective.servers.local).toEqual({ configurationError: expect.stringMatching(/deletion conflicts/i) });
    expect(JSON.stringify(effective.servers.local).includes(secret)).toBe(false);

    mcp = createMcpExtension({ servers: () => store.effectiveServers() });
    for (const action of ["search", "describe", "call"]) {
      const result = await executeMcp(mcp, { action, service: "local", tool: "run" });
      expect(result.isError).toBe(true);
      expect(result.output).toEqual([{ type: "text", text: expect.stringMatching(/deletion conflicts/i) }]);
      expect(JSON.stringify(result).includes(secret)).toBe(false);
    }
    const result = await executeMcp(mcp, { action: "call", service: "other", tool: "run" });
    expect(result.isError).toBe(false);
    expect(result.output).toEqual([{ type: "text", text: "finished" }]);
  } finally {
    await mcp?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP status fails connected servers while private metadata is malformed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-private-config-"));
  const privateDir = path.join(root, "private");
  let mcp: ReturnType<typeof createMcpExtension> | undefined;
  try {
    const script = await writeStdioFixture(root, `
server.registerTool("run", {}, () => ({ content: [{ type: "text", text: "finished" }] }));
await server.connect(new StdioServerTransport());
`);
    const definition = { command: process.execPath, args: [script] };
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      local: definition, other: definition, off: { ...definition, disabled: true },
    } }));
    await mkdir(privateDir);
    const file = path.join(privateDir, "native-mcp.json");
    await writeFile(file, JSON.stringify({ version: 1, entries: {} }));
    const store = new NativeMcpStore(root, privateDir);
    const metadata = await readFile(file, "utf8");
    mcp = createMcpExtension({ servers: () => store.effectiveServers() });
    const call = { action: "call", service: "local", tool: "run" };
    expect((await executeMcp(mcp, call)).isError).toBe(false);
    expect((await executeMcp(mcp, { ...call, service: "other" })).isError).toBe(false);
    const initialRevision = store.effectiveServers().revision;
    expect(mcp.status()).toEqual([
      { name: "local", configurationRevision: initialRevision, status: "connected", toolCount: 1, disabled: false },
      { name: "other", configurationRevision: initialRevision, status: "connected", toolCount: 1, disabled: false },
      { name: "off", configurationRevision: initialRevision, status: "disabled", toolCount: 0, disabled: true },
    ]);

    await writeFile(file, '{"serviceTokens": broken-private-fixture-value}');
    const { revision, configurationError = "" } = store.effectiveServers();
    expect(configurationError).toMatch(/MCP configuration.*native-mcp\.json.*invalid JSON/i);
    expect(revision).not.toBe(initialRevision);
    expect(mcp.status()).toEqual([
      { name: "local", configurationRevision: revision, status: "failed", toolCount: 0, disabled: false },
      { name: "other", configurationRevision: revision, status: "failed", toolCount: 0, disabled: false },
      { name: "off", configurationRevision: revision, status: "disabled", toolCount: 0, disabled: true },
    ]);
    for (const input of [call, { action: "search" }]) {
      const result = await executeMcp(mcp, input);
      expect(result).toEqual({ isError: true, output: [{ type: "text", text: configurationError }] });
      expect(JSON.stringify(result)).not.toContain("broken-private-fixture-value");
      expect(JSON.stringify(result)).not.toContain(root);
    }

    await writeFile(file, metadata);
    expect(await executeMcp(mcp, call)).toEqual({ isError: false, output: [{ type: "text", text: "finished" }] });
    expect(mcp.status().find(({ name }) => name === "local")).toEqual({
      name: "local", configurationRevision: initialRevision, status: "connected", toolCount: 1, disabled: false,
    });
  } finally {
    await mcp?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP search reports malformed workspace configuration without exposing its contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-config-"));
  let mcp: ReturnType<typeof createMcpExtension> | undefined;
  try {
    const store = new NativeMcpStore(root, path.join(root, "private"));
    await writeFile(path.join(root, ".mcp.json"), '{"mcpServers": broken-fixture-value}');
    mcp = createMcpExtension({ servers: () => store.effectiveServers() });
    const result = await executeMcp(mcp, { action: "search" });
    expect(result.isError).toBe(true);
    expect(result.output).toEqual([{ type: "text", text: expect.stringMatching(/MCP configuration.*\.mcp\.json.*invalid JSON/i) }]);
    expect(JSON.stringify(result)).not.toContain("broken-fixture-value");
    expect(JSON.stringify(result)).not.toContain(root);
  } finally {
    await mcp?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an HTTP MCP check queues behind the active tool call before closing its session", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  let handshakes = 0;
  const replyToRequest = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") {
      events.push("session closed");
      return new Response(null, { status: 204 });
    }
    const { id, method, params } = JSON.parse(String(init?.body));
    switch (method) {
      case "initialize":
        return Response.json({ jsonrpc: "2.0", id, result: {
          protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
        } }, { headers: { "mcp-session-id": String(++handshakes) } });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return Response.json({ jsonrpc: "2.0", id, result: { tools: [{ name: "wait", inputSchema: { type: "object" } }] } });
      case "tools/call":
        started.resolve();
        await release.promise;
        init?.signal?.throwIfAborted();
        events.push("tool finished");
        return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "finished" }] } });
      default:
        throw new Error(`Unexpected MCP method ${method}`);
    }
  };
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(replyToRequest, { preconnect: () => {} }));
  const mcp = createMcpExtension({ servers: () => ({
    revision: "fixture", secrets: [], servers: { remote: { disabled: false, transport: { type: "http", url: "https://fixture.example/mcp" } } },
  }) });
  try {
    const call = executeMcp(mcp, { action: "call", service: "remote", tool: "wait" });
    await started.promise;
    const checking = mcp.check("remote", import.meta.dir).then((status) => {
      events.push("check finished");
      return status;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual([]);
    release.resolve();
    expect(await call).toEqual({ isError: false, output: [{ type: "text", text: "finished" }] });
    expect(await checking).toMatchObject({ status: "connected", toolCount: 1 });
    expect(handshakes).toBe(2);
    expect(events).toEqual(["tool finished", "session closed", "check finished"]);
  } finally {
    release.resolve();
    try { await mcp.close(); }
    finally { fetchMock.mockRestore(); }
  }
});

test("checking another MCP service defers retirement and keeps OAuth tokens redacted on the replacement connection", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const retired = Promise.withResolvers<void>();
  const token = crypto.randomUUID();
  const events: string[] = [];
  let secondPath = "/second";
  const replyToRequest = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const pathname = new URL(String(input)).pathname;
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") {
      if (pathname === "/second") {
        events.push("old session closed");
        retired.resolve();
      }
      return new Response(null, { status: 204 });
    }
    const { id, method, params } = JSON.parse(String(init?.body));
    switch (method) {
      case "initialize":
        return Response.json({ jsonrpc: "2.0", id, result: {
          protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
        } }, { headers: { "mcp-session-id": crypto.randomUUID() } });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return Response.json({ jsonrpc: "2.0", id, result: { tools: [{ name: "wait", inputSchema: { type: "object" } }] } });
      case "tools/call":
        if (pathname === "/second") {
          started.resolve();
          await release.promise;
          init?.signal?.throwIfAborted();
          events.push("tool finished");
        }
        return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Finished: ${token}` }] } });
      default:
        throw new Error("Unexpected MCP method");
    }
  };
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(replyToRequest, { preconnect: () => {} }));
  const mcp = createMcpExtension({
    servers: () => ({ revision: secondPath, secrets: [], servers: {
      first: { disabled: false, transport: { type: "http", url: "https://fixture.example/first" } },
      second: { disabled: false, transport: { type: "http", url: `https://fixture.example${secondPath}` } },
    } }),
    authProvider: (_service, url) => new URL(url).pathname === "/second" ? { async token() { return token; } } : undefined,
  });
  try {
    const input = { action: "call", service: "second", tool: "wait" };
    const call = executeMcp(mcp, input);
    await started.promise;
    secondPath = "/replacement";
    expect(await mcp.check("first")).toMatchObject({ status: "connected", toolCount: 1 });
    expect(mcp.status().find(({ name }) => name === "second")?.status).toBe("not-connected");
    expect(events).toEqual([]);
    release.resolve();
    expectSafeEqual(await call, { isError: false, output: [{ type: "text", text: "Finished: [redacted]" }] });
    await retired.promise;
    expect(events).toEqual(["tool finished", "old session closed"]);
    const replacement = await executeMcp(mcp, input);
    expectSafeEqual(replacement, { isError: false, output: [{ type: "text", text: "Finished: [redacted]" }] });
  } finally {
    release.resolve();
    try { await mcp.close(); }
    finally { fetchMock.mockRestore(); }
  }
});

test("MCP redacts issued OAuth tokens from disabled service errors and preserves service and tool identifiers", async () => {
  const token = crypto.randomUUID();
  const service = `fixture-${token}`;
  const tool = `read_fixture-${token}`;
  const fixture = await startOAuthMcpServer({ fixedAuthorization: `Bearer ${token}`, toolName: tool });
  let disabled = false;
  const mcp = createMcpExtension({
    servers: () => ({ revision: disabled ? "disabled" : "enabled", secrets: [], servers: {
      [service]: { disabled, transport: { type: "http", url: fixture.url } },
    } }),
    authProvider: () => ({ async token() { return token; } }),
  });
  try {
    const described = await executeMcp(mcp, { action: "describe", service, tool });
    expect(described.isError).toBe(false);
    const metadata = described.output?.[0];
    const identifiers = JSON.parse(metadata?.type === "text" ? metadata.text : "null");
    expect(identifiers?.service === service && identifiers?.tool === tool).toBe(true);
    expect(fixture.observedAuthorization.has(`Bearer ${token}`)).toBe(true);

    disabled = true;
    const failed = await executeMcp(mcp, { action: "call", service, tool });
    expect(JSON.stringify(failed).includes(token)).toBe(false);
    expect(failed).toEqual({ isError: true, output: [{
      type: "text", text: 'MCP service "fixture-[redacted]" is disabled. Enable it in Services before retrying.',
    }] });
    const status = mcp.status();
    expect(status).toHaveLength(1);
    expect(status[0]?.name === service && status[0]?.status === "disabled").toBe(true);
  } finally {
    await mcp.close();
    await fixture.close();
  }
});

test("MCP redacts an issued OAuth token from a model-visible discovery failure", async () => {
  const token = crypto.randomUUID();
  const service = `fixture-${token}`;
  let issued = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return new Response(null, { status: request.headers.get("authorization") === `Bearer ${token}` ? 500 : 401 });
  } });
  const mcp = createMcpExtension({
    servers: () => ({ revision: "fixture", secrets: [], servers: {
      [service]: { disabled: false, transport: { type: "http", url: server.url.href } },
    } }),
    authProvider: () => ({ async token() { issued++; return token; } }),
  });
  try {
    const result = await executeMcp(mcp, { action: "search", service });
    expect(JSON.stringify(result).includes(token)).toBe(false);
    expect(result.isError).toBe(true);
    const text = result.output?.[0]?.type === "text" ? result.output[0].text : "";
    expect(/fixture-\[redacted\].*failed/.test(text) && Bun.deepEquals(result.output, [{ type: "text", text }])).toBe(true);
    expect(issued).toBe(1);
  } finally {
    await mcp.close();
    await server.stop(true);
  }
});

import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ToolResultEntry, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { setSetting } from "../../../persistence/settings.ts";
import { createWebExtension, readWebExemptRanges, WEB_EXEMPT_RANGES_SETTING } from "./web.ts";

const MAX_DOWNLOAD_BYTES = 5_000_000;
const loopback = { exemptRanges: () => ["127.0.0.0/8"] };
const article = `<!DOCTYPE html><html><head><title>A field guide</title></head><body>
  <article><h1>A field guide</h1><h2>Trail notes</h2>
  <p>A clear trail follows the river before climbing to the overlook. Bring water and leave enough daylight for the return.</p>
  <p>Look for <strong>blue markers</strong> beside the bridge and the first fork in the path.</p></article>
</body></html>`;

type WebOptions = Parameters<typeof createWebExtension>[0];

function webFetch(url: string, options?: WebOptions, context: Context = BACKGROUND_CONTEXT) {
  const tool = createWebExtension(options).tools?.find((item) => item.name === "web_fetch");
  if (!tool) throw new Error("web_fetch was not registered");
  return tool.execute({ url }, {} as never, context);
}

function text(result: ToolExecutionResult) {
  expect(result.output).toHaveLength(1);
  const [content] = Array.isArray(result.output) ? result.output : [];
  if (content?.type !== "text") throw new Error("web_fetch did not return text");
  return content.text;
}

function stub(fetch: (request: Request) => Response | Promise<Response>) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
}

function response(body: BodyInit, contentType = "text/plain") {
  return new Response(body, { headers: { "Content-Type": contentType } });
}

test("web_fetch refuses loopback before connecting and names the range and setting", async () => {
  let requests = 0;
  using server = stub(() => { requests++; return response("internal"); });
  const result = await webFetch(server.url.href);
  expect(result.isError).toBe(true);
  expect(text(result)).toBe("web_fetch refused 127.0.0.1: loopback address 127.0.0.0/8. To allow it, add the range to the web_exempt_ranges setting.");
  expect(requests).toBe(0);
});

test("web_fetch accepts 127.0.0.0/8 when Settings exempts it", async () => {
  using server = stub(() => response("allowed"));
  using db = new Database(":memory:");
  db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const options = { exemptRanges: () => readWebExemptRanges(db) };
  expect((await webFetch(server.url.href, options)).isError).toBe(true);
  setSetting(db, WEB_EXEMPT_RANGES_SETTING, '["127.0.0.0/8"]');
  const allowed = await webFetch(server.url.href, options);
  expect(allowed.isError).toBeFalsy();
  expect(text(allowed)).toBe("allowed");
});

test("web_exempt_ranges defaults to empty and ignores malformed JSON and invalid CIDRs", () => {
  using db = new Database(":memory:");
  db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  expect(readWebExemptRanges(undefined)).toEqual([]);
  expect(readWebExemptRanges(db)).toEqual([]);
  for (const invalid of ['["127.0.0.0/8"', '"127.0.0.0/8"']) {
    setSetting(db, WEB_EXEMPT_RANGES_SETTING, invalid);
    expect(readWebExemptRanges(db)).toEqual([]);
  }
  setSetting(db, WEB_EXEMPT_RANGES_SETTING, JSON.stringify([false, "0.0.0.0/", "127.0.0.1", "127.0.0.0/33", "127.0.0.0/8", "fc00::/7"]));
  expect(readWebExemptRanges(db)).toEqual(["127.0.0.0/8", "fc00::/7"]);
});

test("web_fetch refuses non-HTTP URLs, malformed URLs and embedded credentials", async () => {
  for (const [url, message] of [
    ["file:///tmp/file", "HTTP or HTTPS"],
    ["not a URL", "invalid URL"],
    ["http://user:password@127.0.0.1/", "credentials"],
  ] as const) {
    const result = await webFetch(url);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(text(result)).not.toContain("password");
  }
});

test("web_fetch refuses private, shared, local, multicast, reserved and mapped IP literals", async () => {
  for (const [literal, range] of [
    ["10.99.0.1", "10.0.0.0/8"],
    ["172.31.0.1", "172.16.0.0/12"],
    ["192.168.5.6", "192.168.0.0/16"],
    ["100.127.1.2", "100.64.0.0/10"],
    ["169.254.1.2", "169.254.0.0/16"],
    ["224.1.2.3", "224.0.0.0/4"],
    ["255.255.255.255", "240.0.0.0/4"],
    ["0.0.0.0", "0.0.0.0/8"],
    ["[::]", "::/128"],
    ["[::1]", "::1/128"],
    ["[fd12::1]", "fc00::/7"],
    ["[fe80::1]", "fe80::/10"],
    ["[ff01::1]", "ff00::/8"],
    ["[::ffff:127.0.0.1]", "::ffff:0:0/96"],
  ] as const) {
    const result = await webFetch(`http://${literal}/`, literal.startsWith("[::ffff:") ? loopback : undefined);
    expect(result.isError, literal).toBe(true);
    expect(text(result), literal).toContain(range);
  }
});

test("web_fetch checks DNS results for localhost before connecting", async () => {
  let requests = 0;
  using server = stub(() => { requests++; return response("internal"); });
  const result = await webFetch(`http://localhost:${server.port}/`);
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(/web_fetch refused (?:127\.0\.0\.1|::1): loopback address/);
  expect(requests).toBe(0);
});

test("web_fetch rechecks a redirect and refuses an internal destination", async () => {
  let requests = 0;
  using server = stub(() => {
    requests++;
    return new Response(null, { status: 302, headers: { Location: "http://127.0.0.2/blocked" } });
  });
  const result = await webFetch(server.url.href, { exemptRanges: () => ["127.0.0.1/32"] });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("web_fetch refused 127.0.0.2: loopback address 127.0.0.0/8");
  expect(requests).toBe(1);
});

test("web_fetch follows at most five redirects", async () => {
  const paths: string[] = [];
  using server = stub((request) => {
    paths.push(new URL(request.url).pathname);
    return new Response(null, { status: 302, headers: { Location: `/${paths.length}` } });
  });
  const result = await webFetch(server.url.href, loopback);
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(/5 redirects/);
  expect(paths).toEqual(["/", "/1", "/2", "/3", "/4", "/5"]);
});

test("web_fetch refuses a Content-Length above 5 MB before inspecting the content type", async () => {
  using server = stub(() => response(new Uint8Array(MAX_DOWNLOAD_BYTES + 1), "application/octet-stream"));
  const result = await webFetch(server.url.href, loopback);
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("5 MB");
});

test("web_fetch stops a stream with no Content-Length when it exceeds 5 MB", async () => {
  using server = stub(() => response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_DOWNLOAD_BYTES));
      controller.enqueue(new Uint8Array([65]));
    },
  })));
  const result = await webFetch(server.url.href, loopback);
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("5 MB");
});

test("web_fetch returns an error when the extraction worker times out", async () => {
  using server = stub(() => response(article, "text/html"));
  const result = await webFetch(server.url.href, { ...loopback, extractionTimeoutMs: 1 });
  expect(result.isError).toBe(true);
  expect(text(result)).toBe("Page extraction timed out after 1 ms");
});

test("a 10 ms timer fires while web_fetch waits for the extraction worker", async () => {
  const paragraph = "<p>A clear trail follows the river before climbing to the overlook. Bring enough water for the return.</p>";
  using server = stub(() => response(`<html><body><article>${paragraph.repeat(8000)}</article></body></html>`, "text/html"));
  const postMessage = Worker.prototype.postMessage;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerFired = false;
  const dispatch = spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
    timer = setTimeout(() => { timerFired = true; }, 10);
    return Reflect.apply(postMessage, this, args);
  });
  try {
    const result = await webFetch(server.url.href, loopback);
    expect(timerFired).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("A clear trail");
  } finally {
    clearTimeout(timer);
    dispatch.mockRestore();
  }
});

test("web_fetch extracts HTML to Markdown and reports the final URL after redirects", async () => {
  const redirects = ["/1", "/2", "/3", "/4", "/guide"];
  using server = stub((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/guide") return response(article, "text/html; charset=utf-8");
    return new Response(null, { status: 302, headers: { Location: redirects[Number(path.slice(1))]! } });
  });
  const result = await webFetch(server.url.href, loopback);
  expect(result.isError).toBeFalsy();
  expect(text(result)).toContain("# A field guide");
  expect(text(result)).toContain(new URL("/guide", server.url).href);
  expect(text(result)).toContain("## Trail notes");
  expect(text(result)).toContain("**blue markers**");
});

test("web_fetch returns plain text and Markdown bodies as received", async () => {
  using server = stub((request) => new URL(request.url).pathname === "/markdown"
    ? response("# Notes\n\n**first**\n", "text/markdown")
    : response("Keep the café open.\n", "text/plain; charset=utf-8"));
  const plain = await webFetch(server.url.href, loopback);
  expect(plain.isError).toBeFalsy();
  expect(text(plain)).toBe("Keep the café open.\n");
  const markdown = await webFetch(new URL("/markdown", server.url).href, loopback);
  expect(markdown.isError).toBeFalsy();
  expect(text(markdown)).toBe("# Notes\n\n**first**\n");
});

test("web_fetch decodes Windows-1252 text using the Content-Type charset", async () => {
  const bytes = Uint8Array.of(0x63, 0x61, 0x66, 0xe9);
  using server = stub(() => response(bytes, 'text/plain; CHARSET = "windows-1252"'));
  const result = await webFetch(server.url.href, loopback);
  expect(result.isError).toBeFalsy();
  expect(text(result)).toBe("café");
});

test("web_fetch falls back to UTF-8 for an unsupported charset", async () => {
  using server = stub(() => response("café", "text/plain; charset=unsupported-encoding"));
  const result = await webFetch(server.url.href, loopback);
  expect(result.isError).toBeFalsy();
  expect(text(result)).toBe("café");
});

test("web_fetch falls back to body text and reports an unreadable page", async () => {
  using server = stub((request) => response(new URL(request.url).pathname === "/empty"
    ? "<html><body> </body></html>"
    : "<html><head><title>Menu</title></head><body><footer>Opening hours</footer></body></html>", "text/html"));
  const fallback = await webFetch(server.url.href, loopback);
  expect(fallback.isError).toBeFalsy();
  expect(text(fallback)).toContain("Opening hours");
  const empty = await webFetch(new URL("/empty", server.url).href, loopback);
  expect(empty.isError).toBe(true);
  expect(text(empty)).toContain("no readable text");
});

test("web_fetch reports no readable text when the body only contains scripts and styles", async () => {
  using server = stub(() => response(
    "<html><body><script>const hidden = 'script text';</script><style>p { color: red; }</style></body></html>",
    "text/html",
  ));
  const result = await webFetch(server.url.href, loopback);
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("no readable text");
});

test("web_fetch preserves visible text when HTML omits the body element", async () => {
  using server = stub(() => response(
    "<html><head><title>Hours</title></head><p>Open today</p></html>",
    "text/html",
  ));
  const result = await webFetch(server.url.href, loopback);
  expect(result.isError).toBeFalsy();
  expect(text(result)).toContain("Open today");
});

test("web_fetch reports no readable text when the body only contains hidden content", async () => {
  using server = stub((request) => {
    const attribute = new URL(request.url).pathname === "/aria-hidden" ? 'aria-hidden="true"' : "hidden";
    return response(`<html><body><p ${attribute}>Closed for review</p></body></html>`, "text/html");
  });
  for (const path of ["/hidden", "/aria-hidden"]) {
    const result = await webFetch(new URL(path, server.url).href, loopback);
    expect(result.isError, path).toBe(true);
    expect(text(result), path).toContain("no readable text");
  }
});

test("web_fetch refuses unsupported content types", async () => {
  using server = stub(() => response("{}", "application/json"));
  const result = await webFetch(server.url.href, loopback);
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("unsupported content type: application/json");
});

test("web_fetch rethrows the Turn abort while a download is pending", async () => {
  const abort = new AbortController();
  const requested = Promise.withResolvers<void>();
  using server = stub(() => {
    requested.resolve();
    return response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("first byte")); },
    }));
  });
  const reason = new DOMException("Turn aborted", "AbortError");
  const running = webFetch(server.url.href, loopback, withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
  await Promise.race([requested.promise, running]);
  abort.abort(reason);
  await expect(running).rejects.toBe(reason);
});

test("a scripted Turn receives the registered web_fetch tool result", async () => {
  using server = stub(() => response("Trail conditions are clear."));
  const provider = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  provider.setResponses([
    fauxAssistantMessage([fauxToolCall("web_fetch", { url: server.url.href })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished"),
  ]);
  const context = BACKGROUND_CONTEXT;
  const registry = createRegistry();
  registry.install(createWebExtension(loopback));
  const models = createModels();
  models.setProvider(provider.provider);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { registry, models }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await conversation.configure({ model: { provider: "fake", modelId: "fake-model" } }, context);
    const submission = await conversation.submit({ type: "input", content: "Read the trail conditions." }, context);
    expect((await submission.wait(context)).status).toBe("done");
    const { items } = await conversation.entries({ order: "ascending" }, 20, undefined, context);
    expect(items.filter(ToolResultEntry.is).flatMap((entry) => entry.model ?? [])).toEqual([
      expect.objectContaining({ role: "toolResult", isError: false, content: [{ type: "text", text: "Trail conditions are clear." }] }),
    ]);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

async function webSearch(args: Record<string, unknown>, options: WebOptions, context: Context = BACKGROUND_CONTEXT) {
  const tool = createWebExtension(options).tools?.find((item) => item.name === "web_search");
  if (!tool) throw new Error("web_search was not registered");
  return tool.execute(args, {} as never, context);
}

type McpRequest = { id: number; method: string; params?: Record<string, unknown> };

function mcpStub(
  call: (request: McpRequest) => Response,
  initialized = () => new Response(null, { status: 202 }),
  resume?: (request: Request) => Response,
) {
  const requests: { method: string; key: string | null; url: string }[] = [];
  const calls: McpRequest[] = [];
  const server = stub(async (request) => {
    requests.push({ method: request.method, key: request.headers.get("x-api-key"), url: request.url });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method === "GET" && resume) return resume(request);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json() as McpRequest;
    switch (message.method) {
      case "initialize":
        return Response.json({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "loopback-exa", version: "1.0.0" },
        } }, { headers: { "Mcp-Session-Id": "local-test-session" } });
      case "notifications/initialized":
        return initialized();
      case "notifications/cancelled":
        return new Response(null, { status: 202 });
      case "tools/call":
        calls.push(message);
        return call(message);
      default:
        return new Response(null, { status: 400 });
    }
  });
  const endpoint = new URL("/mcp", server.url).href;
  const externalRequests: string[] = [];
  const realFetch = globalThis.fetch;
  const localFetch: typeof fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const destination = new URL(input instanceof Request ? input.url : String(input));
    if (destination.origin !== server.url.origin) {
      externalRequests.push(destination.href);
      throw new Error("MCP test attempted a non-loopback request");
    }
    return realFetch(input, init);
  }, { preconnect: realFetch.preconnect });
  const fetchGuard = spyOn(globalThis, "fetch").mockImplementation(localFetch);
  return {
    options: { searchEndpoint: endpoint }, requests, calls,
    [Symbol.dispose]() {
      fetchGuard.mockRestore();
      server.stop(true);
      expect(externalRequests).toEqual([]);
    },
  };
}

function mcpResult(request: McpRequest, ...blocks: string[]) {
  return { jsonrpc: "2.0", id: request.id, result: { content: blocks.map((text) => ({ type: "text", text })) } };
}

function pendingResponse() {
  return response(new ReadableStream(), "text/event-stream");
}

const searchQuery = "river trails";
const searchArgs = { query: searchQuery };
const exaText = "Title: A field guide\nURL: https://example.test/guide\nA clear trail follows the river.";

function expectRateLimit(result: ToolExecutionResult) {
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(/rate limited/i);
  expect(text(result)).toMatch(/wait/i);
  expect(text(result)).toContain("browser tool");
  expect(text(result)).not.toMatch(/no results/i);
}

function expectSearchFailure(result: ToolExecutionResult) {
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(/search failed/i);
  expect(text(result)).toContain("browser tool");
}

test("web_search calls web_search_exa over local MCP without a key and joins the returned text", async () => {
  using mcp = mcpStub((request) => response(`data: ${JSON.stringify(mcpResult(request, exaText, "A second result."))}\n\n`, "text/event-stream"));
  const result = await webSearch({ ...searchArgs, numResults: 3 }, mcp.options);
  expect(result.isError).toBeFalsy();
  expect(text(result)).toBe(`Search results for "${searchQuery}":\n\n${exaText}\n\nA second result.`);
  expect(mcp.calls.map(({ method, params }) => ({ method, params }))).toEqual([
    { method: "tools/call", params: { name: "web_search_exa", arguments: { query: searchQuery, numResults: 3 } } },
  ]);
  expect(mcp.requests.map(({ key }) => key)).toEqual([null, null, null, null]);
  expect(mcp.requests.at(-1)?.method).toBe("DELETE");
});

test("web_search sends the Exa key only in a header and redacts it from results and errors", async () => {
  const key = "exa-test-secret";
  const pastedKey = `${key} \t\n`;
  let count = 0;
  using mcp = mcpStub((request) => ++count === 1
    ? Response.json(mcpResult(request, `Echo: ${key}\nPasted: ${pastedKey}`))
    : new Response(`Upstream echoed ${key} and ${pastedKey}`, { status: 500 }));
  const options = { ...mcp.options, searchKey: () => pastedKey };
  const result = await webSearch({ query: `${searchQuery} ${key}` }, options);
  const failure = await webSearch(searchArgs, options);
  expect(result.isError).toBeFalsy();
  expect(text(result)).toContain("Echo: [redacted]");
  expect(text(result)).toContain("Pasted: [redacted]");
  expect(text(result)).not.toContain(key);
  expect(text(result)).not.toContain(pastedKey);
  expectSearchFailure(failure);
  expect(text(failure)).not.toContain(key);
  expect(text(failure)).not.toContain(pastedKey);
  expect(mcp.calls.map(({ params }) => params?.arguments)).toEqual([{ query: `${searchQuery} ${key}` }, searchArgs]);
  expect(mcp.requests).toHaveLength(8);
  for (const request of mcp.requests) {
    expect(request.key).toBe(key);
    expect(request.url).toBe(mcp.options.searchEndpoint);
  }
});

test("web_search rejects blank queries and result counts outside the integer range 1 to 20", async () => {
  using mcp = mcpStub((request) => Response.json(mcpResult(request, exaText)));
  const blank = await webSearch({ query: " \t\n" }, mcp.options);
  expect(blank.isError).toBe(true);
  expect(text(blank)).toMatch(/non-empty query/i);
  for (const numResults of [0, 1.5, 21]) {
    const invalid = await webSearch({ ...searchArgs, numResults }, mcp.options);
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toMatch(/integer between 1 and 20/i);
  }
  expect(mcp.requests).toEqual([]);
});

test("web_search reports HTTP 429 as a rate limit", async () => {
  using mcp = mcpStub(() => new Response("Too many requests", { status: 429 }));
  expectRateLimit(await webSearch(searchArgs, mcp.options));
});

function openTextResponse(status: number, firstChunk: string) {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(firstChunk)); },
  }), { status, headers: { "Content-Type": "text/plain" } });
}

test("web_search reports HTTP 429 without waiting for a stalled body", async () => {
  using mcp = mcpStub(() => openTextResponse(429, "Too many requests"));
  const searchTimeoutMs = 1_000;
  const start = performance.now();
  const result = await webSearch(searchArgs, { ...mcp.options, searchTimeoutMs });
  expectRateLimit(result);
  expect(performance.now() - start).toBeLessThan(searchTimeoutMs / 2);
  expect(mcp.calls).toHaveLength(1);
  expect(mcp.requests.at(-1)?.method).toBe("DELETE");
});

test("web_search reports HTTP 429 on SSE resume without retrying", async () => {
  const resumedFrom: (string | null)[] = [];
  using mcp = mcpStub(
    () => response("id: checkpoint\nretry: 10\n\n", "text/event-stream"),
    undefined,
    (request) => {
      resumedFrom.push(request.headers.get("last-event-id"));
      return openTextResponse(429, "Too many requests");
    },
  );
  const searchTimeoutMs = 1_000;
  const start = performance.now();
  const result = await webSearch(searchArgs, { ...mcp.options, searchTimeoutMs });
  expect(resumedFrom[0]).toBe("checkpoint");
  expectRateLimit(result);
  expect(resumedFrom).toEqual(["checkpoint"]);
  expect(performance.now() - start).toBeLessThan(searchTimeoutMs / 2);
  expect(mcp.calls).toHaveLength(1);
  expect(mcp.requests.at(-1)?.method).toBe("DELETE");
});

test("web_search ignores rate-limit text in a successful notification acknowledgement", async () => {
  const acknowledgements = [
    () => response("ai.exa/rateLimited"),
    () => openTextResponse(200, "ai.exa/rateLimited"),
  ];
  using mcp = mcpStub((request) => Response.json(mcpResult(request, exaText)), () => acknowledgements.shift()!());
  for (let i = 0; i < 2; i++) {
    const result = await webSearch(searchArgs, { ...mcp.options, searchTimeoutMs: 1_000 });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain(exaText);
  }
  expect(mcp.calls).toHaveLength(2);
});

const quotedMarker = 'Snippet: The docs mention "ai.exa/rateLimited".';

test("web_search preserves a JSON search result that quotes the rate-limit marker", async () => {
  using mcp = mcpStub((request) => Response.json(mcpResult(request, quotedMarker)));
  const result = await webSearch(searchArgs, mcp.options);
  expect(result.isError).toBeFalsy();
  expect(text(result)).toContain(quotedMarker);
});

test("web_search preserves an SSE search result that quotes the rate-limit marker", async () => {
  using mcp = mcpStub((request) => response(`data: ${JSON.stringify(mcpResult(request, quotedMarker))}\n\n`, "text/event-stream"));
  const result = await webSearch(searchArgs, mcp.options);
  expect(result.isError).toBeFalsy();
  expect(text(result)).toContain(quotedMarker);
});

test("web_search ignores a false rate-limit flag on a successful result", async () => {
  using mcp = mcpStub((request) => Response.json({ ...mcpResult(request, exaText), "ai.exa/rateLimited": false }));
  const result = await webSearch(searchArgs, mcp.options);
  expect(result.isError).toBeFalsy();
  expect(text(result)).toContain(exaText);
});

test("web_search detects the rate-limit flag in an HTTP error body", async () => {
  const bodies = ["ai.exa/rateLimited", '{"ai.exa/rateLimited":true}'];
  using mcp = mcpStub(() => new Response(bodies.shift(), { status: 503 }));
  expectRateLimit(await webSearch(searchArgs, mcp.options));
  expectRateLimit(await webSearch(searchArgs, mcp.options));
});

test("web_search detects an HTTP 200 standalone marker in an unsupported content type", async () => {
  const bodies = [" \nai.exa/rateLimited\n", '{"ai.exa/rateLimited":true}', "ai.exa/rateLimited: true"];
  using mcp = mcpStub(() => response(bodies.shift()!, "text/plain; charset=utf-8"));
  for (let i = 0; i < 3; i++) expectRateLimit(await webSearch(searchArgs, mcp.options));
  expect(mcp.calls).toHaveLength(3);
});

test("web_search detects a standalone marker in an unsupported HTTP 200 body of exactly 64 KiB", async () => {
  const body = "ai.exa/rateLimited".padStart(64 * 1024);
  using mcp = mcpStub(() => response(body));
  expectRateLimit(await webSearch(searchArgs, mcp.options));
});

test("web_search limits unsupported HTTP 200 body inspection to 64 KiB", async () => {
  const bodies = [
    `${" ".repeat(64 * 1024)}ai.exa/rateLimited`,
    `${"ai.exa/rateLimited".padEnd(64 * 1024)}x`,
  ];
  using mcp = mcpStub(() => response(bodies.shift()!));
  for (let i = 0; i < 2; i++) {
    const result = await webSearch(searchArgs, mcp.options);
    expectSearchFailure(result);
    expect(text(result)).not.toMatch(/rate limited/i);
  }
});

test("web_search recognizes a JSON-RPC rate-limit message or error data at HTTP 200", async () => {
  const errors = [
    { code: -32000, message: "You've hit Exa's free MCP rate limit" },
    { code: -32000, message: "Search unavailable [ai.exa/rateLimited]" },
    { code: -32000, message: "ai.exa/rateLimited: true" },
    { code: -32000, message: "Search unavailable", data: { nested: { "ai.exa/rateLimited": true } } },
    { code: -32000, message: "Search unavailable", data: "ai.exa/rateLimited" },
  ];
  const count = errors.length;
  using mcp = mcpStub(({ id }) => Response.json({ jsonrpc: "2.0", id, error: errors.shift() }));
  for (let i = 0; i < count; i++) expectRateLimit(await webSearch(searchArgs, mcp.options));
  expect(mcp.calls).toHaveLength(count);
});

test("web_search recognizes JSON-RPC Too many requests and numeric status 429 at HTTP 200", async () => {
  const errors = [
    { code: -32000, message: "Too many requests" },
    { code: -32000, message: "Search rateLimited." },
    { code: -32000, message: "Search unavailable", data: { status: 429 } },
    { code: -32000, message: "ai.exa/rateLimited=false", data: { status: 429, "ai.exa/rateLimited": false } },
  ];
  const count = errors.length;
  using mcp = mcpStub(({ id }) => Response.json({ jsonrpc: "2.0", id, error: errors.shift() }));
  for (let i = 0; i < count; i++) expectRateLimit(await webSearch(searchArgs, mcp.options));
  expect(mcp.calls).toHaveLength(count);
});

test("web_search recognizes throttle wording at prose boundaries", async () => {
  const cases = [
    ["lookup.rateLimited.cache", false],
    ["x.rateLimited", false],
    ["rateXlimited", false],
    ["rate-limited.cache", false],
    ["Search rateLimited.", true],
    ["Too many requests.", true],
  ] as const;
  const messages = cases.map(([message]) => message);
  using mcp = mcpStub(({ id }) => Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: messages.shift() } }));
  for (const [message, rateLimited] of cases) {
    const result = await webSearch(searchArgs, mcp.options);
    expect(/rate limited/i.test(text(result)), message).toBe(rateLimited);
    if (rateLimited) expectRateLimit(result);
    else expectSearchFailure(result);
  }
  expect(mcp.calls).toHaveLength(cases.length);
});

type FlagReply = (request: McpRequest, flag: string, dataMessage: string) => Response;
const flagReplies: [string, FlagReply][] = [
  ["a JSON-RPC error message", ({ id }, flag) => Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: flag } })],
  ["JSON-RPC error data", ({ id }, flag, dataMessage) => Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: dataMessage, data: flag } })],
  ["an HTTP 503 body", (_request, flag) => new Response(flag, { status: 503 })],
  ["an unsupported HTTP 200 body", (_request, flag) => response(flag)],
];

const exaFlagCases = [
  ["ai.exa/rateLimited", true],
  ["ai.exa/rateLimited: true", true],
  ["ai.exa/rateLimited=true", true],
  ['{"ai.exa/rateLimited":true}', true],
  ['{"ai.exa/rateLimited":false}', false],
  ['[ai.exa/rateLimited="Too many requests"]', false],
  ['ai.exa/rateLimited: "Too many requests"', false],
  ['ai.exa/rateLimited="Too many requests"', false],
  ["ai.exa/rateLimited=null", false],
  ["ai.exa/rateLimited=0", false],
  ["ai.exa/rateLimited=1", false],
  ['ai.exa/rateLimited="true"', false],
  ['ai.exa/rateLimited: "ai.exa/rateLimited"', false],
  ['ai.exa/rateLimited: "Too many \\"requests\\" and ai.exa/rateLimited"', false],
  ["ai.exa/rateLimited: Search unavailable", false],
  ["ai.exa/rateLimited= true extra", true],
  ["ai.exa/rateLimitedtrue", false, "Search unavailable"],
  ["not_ai.exa/rateLimited", false, "Search unavailable"],
  ["prefix.ai.exa/rateLimited", false, "Search unavailable"],
  ["ai.exa/rateLimited-extra", false, "Search unavailable"],
  ['"ai.exa/rateLimited": "Too many requests"', false],
  ['Exa error: ai.exa/rateLimited: "Too many requests"', false],
  ["[ 'ai.exa/rateLimited' ] = true", true],
  ["[ ai.exa/rateLimited ] : false", false],
  ["ai.exa/rateLimited =", true],
  [quotedMarker, true],
  ["ai.exa/rateLimited=false, ai.exa/rateLimited=true", true],
  ["ai.exa/rateLimited=false, [ai.exa/rateLimited]", true],
  ['ai.exa/rateLimited=false, ai.exa/rateLimited="rate limit"', false],
  ['{"ai.exa/rateLimited":[]}', false],
  ['{"ai.exa/rateLimited":{}}', false],
  ['ai.exa/rateLimited=[{"reason":"ai.exa/rateLimited"}]', false],
  ['ai.exa/rateLimited={"nested":["}\\\" ai.exa/rateLimited=true"]}', false],
  ['ai.exa/rateLimited={"nested":["}\\\" ai.exa/rateLimited=true"]}, ai.exa/rateLimited=true', true],
  ['ai.exa/rateLimited=[], ai.exa/rateLimited=true', true],
] as const;

for (const [source, reply] of flagReplies) {
  test(`web_search interprets Exa rate-limit flags in ${source}`, async () => {
    const replies = [...exaFlagCases];
    using mcp = mcpStub((request) => {
      const [flag, rateLimited, dataMessage] = replies.shift()!;
      return reply(request, flag, dataMessage ?? (rateLimited ? "Search unavailable" : "Too many requests"));
    });
    for (const [flag, rateLimited] of exaFlagCases) {
      const result = await webSearch(searchArgs, mcp.options);
      expect(result.isError, flag).toBe(true);
      expect(/rate limited/i.test(text(result)), flag).toBe(rateLimited);
      if (rateLimited) expectRateLimit(result);
      else expectSearchFailure(result);
    }
    expect(mcp.calls).toHaveLength(exaFlagCases.length);
  });
}

test("web_search combines flags from the JSON-RPC error message and structured data", async () => {
  const errors = [
    { message: "ai.exa/rateLimited=true", data: { "ai.exa/rateLimited": false } },
    { message: "ai.exa/rateLimited=false", data: { nested: { "ai.exa/rateLimited": true } } },
    { message: quotedMarker, data: { note: quotedMarker } },
    { message: "Too many requests", data: { "ai.exa/rateLimited": "Too many requests" } },
  ];
  using mcp = mcpStub(({ id }) => Response.json({ jsonrpc: "2.0", id, error: { code: -32000, ...errors.shift() } }));
  for (let i = 0; i < 3; i++) expectRateLimit(await webSearch(searchArgs, mcp.options));
  const result = await webSearch(searchArgs, mcp.options);
  expectSearchFailure(result);
  expect(text(result)).not.toMatch(/rate limited|no results/i);
});

test("web_search leaves malformed JSON-RPC bodies on the protocol error path", async () => {
  using mcp = mcpStub(() => Response.json({ "ai.exa/rateLimited": true }));
  const result = await webSearch(searchArgs, mcp.options);
  expectSearchFailure(result);
  expect(text(result)).not.toMatch(/rate limited|no results/i);
});

test("web_search describes numResults as optional without promising a default", () => {
  const tool = createWebExtension().tools?.find((item) => item.name === "web_search");
  expect(tool?.parameters).toMatchObject({
    required: ["query"],
    properties: { numResults: { description: "Optional maximum results, an integer between 1 and 20." } },
  });
});

test("web_search reports HTTP 500 as a failure and suggests the browser tool", async () => {
  using mcp = mcpStub(() => new Response("Upstream unavailable", { status: 500 }));
  const result = await webSearch(searchArgs, mcp.options);
  expectSearchFailure(result);
  expect(text(result)).not.toMatch(/rate limited|no results/i);
});

test("web_search reports a tool call timeout as a failure and closes the MCP session", async () => {
  using mcp = mcpStub(pendingResponse);
  expectSearchFailure(await webSearch(searchArgs, { ...mcp.options, searchTimeoutMs: 200 }));
  expect(mcp.calls).toHaveLength(1);
  expect(mcp.requests.at(-1)?.method).toBe("DELETE");
});

test("web_search times out when the initialized notification stalls", async () => {
  using mcp = mcpStub((request) => Response.json(mcpResult(request, exaText)), pendingResponse);
  expectSearchFailure(await webSearch(searchArgs, { ...mcp.options, searchTimeoutMs: 200 }));
  expect(mcp.calls).toEqual([]);
  expect(mcp.requests.at(-1)?.method).toBe("DELETE");
});

test("web_search reports empty content as no results", async () => {
  using mcp = mcpStub((request) => Response.json(mcpResult(request)));
  const result = await webSearch(searchArgs, mcp.options);
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(/no results/i);
  expect(text(result)).not.toMatch(/rate limited|search failed/i);
});

test("web_search rethrows the Turn abort during a search and closes the MCP session", async () => {
  const abort = new AbortController();
  const requested = Promise.withResolvers<void>();
  using mcp = mcpStub(() => {
    requested.resolve();
    return pendingResponse();
  });
  const reason = new DOMException("Turn aborted", "AbortError");
  const running = webSearch(searchArgs, mcp.options, withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
  await Promise.race([requested.promise, running]);
  abort.abort(reason);
  await expect(running).rejects.toBe(reason);
  expect(mcp.calls).toHaveLength(1);
  expect(mcp.requests.at(-1)?.method).toBe("DELETE");
});

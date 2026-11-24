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

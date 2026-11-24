import type { Database } from "bun:sqlite";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Worker } from "node:worker_threads";
import { awaitWithContext, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { getSetting } from "../../../persistence/settings.ts";
import type { ExtractionRequest, ExtractionResult } from "./web.worker.ts";

export const WEB_EXEMPT_RANGES_SETTING = "web_exempt_ranges";

const MAX_DOWNLOAD_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseRange(cidr: string) {
  const [network, prefix, extra] = cidr.split("/");
  if (network === undefined || prefix === undefined || extra !== undefined || !/^\d{1,3}$/.test(prefix) || network.includes("%")) return undefined;
  const family = isIP(network);
  const bits = Number(prefix);
  if (family === 0 || bits > (family === 4 ? 32 : 128)) return undefined;
  const block = new BlockList();
  const type = family === 4 ? "ipv4" : "ipv6";
  block.addSubnet(network, bits, type);
  // BlockList matches mapped addresses against IPv4 rules. Exemptions must match the original family.
  return { matches: (address: string, addressFamily: number) => family === addressFamily && block.check(address, type) };
}

// Specific classifications come first so the refusal names the applicable range.
const refusedRanges = ([
  ["0.0.0.0/8", "unspecified"],
  ["10.0.0.0/8", "private"],
  ["100.64.0.0/10", "carrier-grade NAT"],
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link-local"],
  ["172.16.0.0/12", "private"],
  ["192.0.0.0/24", "reserved"],
  ["192.0.2.0/24", "reserved"],
  ["192.88.99.0/24", "reserved"],
  ["192.168.0.0/16", "private"],
  ["198.18.0.0/15", "reserved"],
  ["198.51.100.0/24", "reserved"],
  ["203.0.113.0/24", "reserved"],
  ["224.0.0.0/4", "multicast"],
  ["240.0.0.0/4", "reserved"],
  ["::/128", "unspecified"],
  ["::1/128", "loopback"],
  ["::ffff:0:0/96", "IPv4-mapped IPv6"],
  ["::/96", "reserved"],
  ["64:ff9b::/96", "IPv4/IPv6 translation"],
  ["64:ff9b:1::/48", "IPv4/IPv6 translation"],
  ["100::/64", "reserved"],
  ["100:0:0:1::/64", "reserved"],
  ["2001::/23", "reserved"],
  ["2001:db8::/32", "reserved"],
  ["2002::/16", "6to4"],
  ["3fff::/20", "reserved"],
  ["5f00::/16", "reserved"],
  ["fc00::/7", "unique-local"],
  ["fe80::/10", "link-local"],
  ["fec0::/10", "site-local"],
  ["ff00::/8", "multicast"],
  ["::/3", "reserved"],
  ["4000::/2", "reserved"],
  ["8000::/1", "reserved"],
] as const).map(([cidr, label]) => ({ cidr, label, ...parseRange(cidr)! }));

type AddressRange = NonNullable<ReturnType<typeof parseRange>>;

export function readWebExemptRanges(db: Database | undefined): readonly string[] {
  const stored = db && getSetting(db, WEB_EXEMPT_RANGES_SETTING);
  if (!stored) return [];
  try {
    const ranges: unknown = JSON.parse(stored);
    if (Array.isArray(ranges)) return ranges.filter((range): range is string => typeof range === "string" && parseRange(range) !== undefined);
  } catch { /* Invalid Settings leave exemptions off. */ }
  return [];
}

function parseUrl(input: string, base?: URL) {
  const url = URL.parse(input, base);
  if (!url) throw new Error("web_fetch received an invalid URL.");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("web_fetch requires an HTTP or HTTPS URL.");
  if (url.username || url.password) throw new Error("web_fetch refuses URLs with embedded credentials.");
  return url;
}

async function checkedAddresses(hostname: string, exemptions: readonly AddressRange[], context: Context) {
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await awaitWithContext(lookup(hostname, { all: true }), context);
  if (!addresses.length) throw new Error(`web_fetch found no addresses for ${hostname}.`);
  for (const { address, family } of addresses) {
    const refused = refusedRanges.find((range) => range.matches(address, family));
    if (refused && !exemptions.some((range) => range.matches(address, family))) {
      throw new Error(`web_fetch refused ${address}: ${refused.label} address ${refused.cidr}. To allow it, add the range to the ${WEB_EXEMPT_RANGES_SETTING} setting.`);
    }
  }
  return addresses;
}

async function fetchChecked(url: URL, exemptions: readonly AddressRange[], context: Context) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await checkedAddresses(hostname, exemptions, context);
  const port = url.port ? `:${url.port}` : "";
  const path = url.href.slice(url.origin.length);
  let failure: unknown;
  for (const { address, family } of addresses) {
    context.abortSignal?.throwIfAborted();
    const host = family === 6 ? `[${address}]` : address;
    const destination = URL.parse(`${url.protocol}//${host}${port}${path}`);
    if (!destination) {
      failure = new Error(`web_fetch cannot connect to the resolved address ${address}.`);
      continue;
    }
    // Dial the checked address directly while preserving the HTTP and TLS identity of the origin.
    // https://bun.com/docs/runtime/networking/fetch#connecting-to-a-specific-address
    const options = {
      redirect: "manual" as const,
      proxy: false as const,
      headers: { Host: url.host },
      ...(url.protocol === "https:" && !isIP(hostname) ? { tls: { serverName: hostname } } : {}),
      signal: context.abortSignal ?? null,
    };
    try { return await fetch(destination, options); }
    catch (error) { failure = error; }
  }
  throw failure;
}

function downloadLimitError() {
  return new Error("web_fetch download exceeds the 5 MB limit.");
}

function bodyDecoder(contentType: string) {
  const parameters = contentType.matchAll(/;\s*([^\s;=]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;\s]+))/g);
  for (const [, name, quoted, unquoted] of parameters) {
    if (name?.toLowerCase() !== "charset") continue;
    try { return new TextDecoder(quoted?.replace(/\\(.)/g, "$1") ?? unquoted); }
    catch (error) { if (!(error instanceof RangeError)) throw error; }
    break;
  }
  return new TextDecoder();
}

async function readBody(response: Response, contentType: string, context: Context) {
  if (!response.body) return "";
  const decoder = bodyDecoder(contentType);
  const reader = response.body.getReader();
  const text: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await awaitWithContext(reader.read(), context);
      if (done) return text.join("") + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_DOWNLOAD_BYTES) throw downloadLimitError();
      text.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function download(url: URL, exemptions: readonly AddressRange[], context: Context) {
  for (let redirects = 0; ; redirects++) {
    const timeout = new AbortController();
    const requestContext = withAbortSignal(timeout.signal, context);
    const timer = setTimeout(() => timeout.abort(new Error("web_fetch request timed out after 30 seconds.")), REQUEST_TIMEOUT_MS);
    let response: Response | undefined;
    try {
      response = await fetchChecked(url, exemptions, requestContext);
      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects >= MAX_REDIRECTS) throw new Error(`web_fetch exceeded ${MAX_REDIRECTS} redirects.`);
        const location = response.headers.get("location");
        if (!location) throw new Error("web_fetch received a redirect without a Location header.");
        url = parseUrl(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`web_fetch received HTTP ${response.status}.`);
      if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES) throw downloadLimitError();
      const contentType = response.headers.get("content-type") ?? "";
      const type = contentType.split(";", 1)[0]?.trim().toLowerCase();
      if (type !== "text/html" && type !== "text/plain" && type !== "text/markdown") {
        throw new Error(`web_fetch received an unsupported content type: ${type || "missing Content-Type"}.`);
      }
      const body = await readBody(response, contentType, requestContext);
      requestContext.abortSignal?.throwIfAborted();
      return { body, type, url };
    } catch (error) {
      requestContext.abortSignal?.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
    }
  }
}

async function extractPage(input: ExtractionRequest, timeoutMs: number, context: Context) {
  context.abortSignal?.throwIfAborted();
  const worker = new Worker(new URL("./web.worker.ts", import.meta.url));
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error(`Page extraction timed out after ${timeoutMs} ms`)), timeoutMs);
  try {
    const extracted = new Promise<ExtractionResult>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("messageerror", reject);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Page extraction worker exited without a result (${code}).`)));
      worker.postMessage(input);
    });
    return await awaitWithContext(extracted, withAbortSignal(timeout.signal, context));
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

function textResult(text: string, isError = false): ToolExecutionResult {
  return { isError, output: [{ type: "text", text }] };
}

export function createWebExtension(options: { exemptRanges?: () => readonly string[]; extractionTimeoutMs?: number } = {}) {
  return defineExtension({
    name: "omarchy-web",
    tools: [defineTool({
      name: "web_fetch",
      description: "Fetch an HTTP or HTTPS URL and return page text extracted without a browser. HTML is converted to Markdown.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The HTTP or HTTPS URL to read." } },
        required: ["url"],
        additionalProperties: false,
      },
      async execute(args, _api, context) {
        try {
          context.abortSignal?.throwIfAborted();
          const { url: input } = args as { url: string };
          const url = parseUrl(input);
          const exemptions = (options.exemptRanges?.() ?? []).map(parseRange).filter((range) => range !== undefined);
          const page = await download(url, exemptions, context);
          context.abortSignal?.throwIfAborted();
          if (page.type !== "text/html") return textResult(page.body);
          const extracted = await extractPage({ html: page.body, url: page.url.href }, options.extractionTimeoutMs ?? 10_000, context);
          context.abortSignal?.throwIfAborted();
          if ("error" in extracted) return textResult(extracted.error, true);
          return textResult(`# ${extracted.title}\n\n${page.url.href}\n\n${extracted.markdown}`);
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          return textResult(error instanceof Error ? error.message : "web_fetch failed.", true);
        }
      },
    })],
  });
}

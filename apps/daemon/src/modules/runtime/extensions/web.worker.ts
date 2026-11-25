import { parentPort } from "node:worker_threads";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export type ExtractionRequest = { html: string; url: string };
export type ExtractionResult = { markdown: string; title: string } | { error: string };

function extract({ html, url }: ExtractionRequest): ExtractionResult {
  let { document } = parseHTML(html);
  // LinkeDOM keeps a fragment as parsed. Readability expects an HTML document with a head and body.
  if (document.documentElement?.localName !== "html") {
    ({ document } = parseHTML(`<html><body>${html}</body></html>`));
  }
  const root = document.documentElement;
  if (!Array.from(root.children).some((element) => element.localName === "body")) {
    // LinkeDOM creates an empty body without moving the content beside it.
    const { head, body } = document;
    for (const node of Array.from(root.childNodes)) {
      if (node !== head && node !== body) body.appendChild(node);
    }
  }
  const base = URL.parse(document.baseURI ?? url, url)?.href ?? url;
  Object.defineProperties(document, { baseURI: { value: base }, documentURI: { value: url } });
  const title = document.title.trim() || new URL(url).hostname;
  const article = new Readability(document).parse();
  const markdown = article?.content
    ? new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(article.content).trim()
    : "";
  if (markdown) return { markdown, title: article?.title?.trim() || title };
  const body = document.body;
  const hidden = '[hidden], [aria-hidden="true"]';
  for (const element of body.querySelectorAll(`script, style, noscript, template, svg, ${hidden}`)) element.remove();
  const fallback = body.closest(hidden) ? "" : body.textContent?.trim();
  if (fallback) return { markdown: fallback, title };
  return { error: "The page has no readable text." };
}

const port = parentPort;
if (!port) throw new Error("Page extraction requires a worker thread.");
port.once("message", (request: ExtractionRequest) => {
  try {
    port.postMessage(extract(request));
  } catch {
    port.postMessage({ error: "Unable to extract readable text from the page." } satisfies ExtractionResult);
  }
});

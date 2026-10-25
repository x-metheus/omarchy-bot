import { z } from "zod";
import { ConfigurePluginsBody } from "@omarchy-bot/protocol";
import { HttpError } from "../modules/bots/bots.ts";
import type { PluginsService } from "../modules/plugins/plugins.ts";
import { matchPluginDispatch, type PluginCall } from "../modules/plugins/pluginDispatch.ts";

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new HttpError(415, "Use an application/json request body");
  const text = await request.text();
  if (Buffer.byteLength(text) > 128 * 1024) throw new HttpError(413, "Plugin configuration is too large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, "Invalid JSON body"); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid plugin request");
  return parsed.data;
}

function html(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function handlePluginRequest(request: Request, plugins: PluginsService, pathname: string, initiatingOrigin?: string): Promise<Response | undefined> {
  if (pathname !== "/api/plugins" && !pathname.startsWith("/api/plugins/")) return undefined;
  const url = new URL(request.url);
  const route = pathname.slice("/api/plugins".length);
  if (route === "/oauth/callback" && request.method === "GET") {
    let message: string;
    let returnUrl: string | undefined;
    let status = 200;
    try {
      const result = await plugins.finishAuthorization(url);
      message = `Connected ${result.label}. You can close this tab and return to Plugins. Changes apply on the next turn.`;
      returnUrl = result.returnUrl;
    } catch (error) {
      status = error instanceof HttpError ? error.status : 502;
      message = error instanceof HttpError ? error.message : "Authorization could not be completed. Return to Plugins and reconnect the account.";
    }
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Omarchy Bot authorization</title><style>html{color-scheme:light dark;font:18px system-ui}main{max-width:42rem;margin:15vh auto;padding:24px;line-height:1.6}a{color:inherit}</style><main><h1>${status === 200 ? "Account connected" : "Authorization failed"}</h1><p>${html(message)}</p>${returnUrl ? `<a href="${html(returnUrl)}">Return to Omarchy Bot</a>` : ""}</main></html>`, {
      status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" },
    });
  }
  if (route === "/commands" && request.method === "GET") return Response.json(await plugins.commands());
  if (route === "/settings" && request.method === "PUT") {
    plugins.configure((await body(request, ConfigurePluginsBody)).cloudUrl);
    return new Response(null, { status: 204 });
  }
  const matched = matchPluginDispatch(request.method, pathname);
  if (!matched) throw new HttpError(404, "Unknown plugin operation");
  const { row, ids } = matched;
  const parsed = row.body ? await body(request, row.body as z.ZodType<Record<string, unknown>>) : {};
  if (row.action === "authorize_service") {
    const returnUrl = new URL(String(parsed.returnUrl ?? ""));
    const origin = request.headers.get("origin") ?? initiatingOrigin ?? url.origin;
    if (returnUrl.origin !== origin || returnUrl.pathname !== "/" || returnUrl.search || returnUrl.hash || returnUrl.username || returnUrl.password) throw new HttpError(400, "Authorization must return to the initiating client origin");
  }
  const call = (row.action === "save_mcp"
    ? { ...ids, connection: parsed as PluginCall["connection"] }
    : row.method === "GET"
      ? { ...ids, id: ids.id ?? url.searchParams.get("id") ?? undefined, query: url.searchParams.get("q") ?? "", cursor: url.searchParams.get("cursor") ?? undefined, view: url.searchParams.get("view") ?? "trending" }
      : { ...ids, ...(parsed as PluginCall) }) as PluginCall;
  const result = await row.handler(plugins, call);
  if (row.empty) return new Response(null, { status: 204 });
  return Response.json(result, { status: row.created ? 201 : 200, headers: { "cache-control": "no-store" } });
}


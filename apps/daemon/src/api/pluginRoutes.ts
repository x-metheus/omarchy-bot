import { z } from "zod";
import { AuthorizePluginBody, ConfigurePluginsBody, InstallSkillBody, PluginAccountBody, PluginEnabledBody, PluginServiceBody, SaveMcpBody } from "@omarchy-bot/protocol";
import { HttpError } from "../modules/bots/bots.ts";
import type { PluginsService } from "../modules/plugins/plugins.ts";

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

export async function handlePluginRequest(request: Request, plugins: PluginsService, pathname: string): Promise<Response | undefined> {
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
  if (route === "" && request.method === "GET") return Response.json(await plugins.state(), { headers: { "cache-control": "no-store" } });
  if (route === "/inspect" && request.method === "GET") {
    const state = await plugins.state();
    const id = url.searchParams.get("id") ?? "";
    const found = [...state.skills, ...state.mcp, ...state.accounts].find((entry) => entry.id === id);
    if (!found) throw new HttpError(404, "Plugin not found");
    return Response.json(found, { headers: { "cache-control": "no-store" } });
  }
  if (route === "/commands" && request.method === "GET") return Response.json(await plugins.commands());
  if (route === "/settings" && request.method === "PUT") {
    plugins.configure((await body(request, ConfigurePluginsBody)).cloudUrl);
    return new Response(null, { status: 204 });
  }
  if (route === "/catalog" && request.method === "GET") return Response.json(await plugins.catalog(url.searchParams.get("q") ?? "", url.searchParams.get("cursor") ?? undefined, url.searchParams.get("view") ?? "trending"));
  if (route === "/catalog/detail" && request.method === "GET") return Response.json(await plugins.detail(url.searchParams.get("id") ?? ""));
  if (route === "/skills" && request.method === "POST") return Response.json(await plugins.installSkill(await body(request, InstallSkillBody)), { status: 201 });
  if (route === "/skills/update" && request.method === "POST") { await plugins.updateSkills(); return new Response(null, { status: 204 }); }
  if (route === "/mcp" && request.method === "POST") return Response.json(await plugins.saveMcp(null, await body(request, SaveMcpBody)), { status: 201 });
  if (route === "/authorize" && request.method === "POST") {
    const input = await body(request, AuthorizePluginBody);
    const returnUrl = new URL(input.returnUrl);
    const origin = request.headers.get("origin") ?? url.origin;
    if (returnUrl.origin !== origin || returnUrl.pathname !== "/" || returnUrl.search || returnUrl.hash || returnUrl.username || returnUrl.password) throw new HttpError(400, "Authorization must return to the initiating client origin");
    return Response.json(await plugins.authorize(input), { headers: { "cache-control": "no-store" } });
  }
  const mcp = route.match(/^\/mcp\/([^/]+)(\/check|\/authorize|\/update)?$/);
  if (mcp) {
    const id = decodeURIComponent(mcp[1]!);
    if (mcp[2] === "/check" && request.method === "POST") return Response.json(await plugins.checkMcp(id));
    if (mcp[2] === "/authorize" && request.method === "POST") {
      const input = await body(request, z.object({ redirectUrl: z.string().url().max(8192).optional() }).strict());
      return Response.json(await plugins.authorizeMcp(id, input.redirectUrl), { headers: { "cache-control": "no-store" } });
    }
    if (mcp[2] === "/update" && request.method === "POST") {
      await body(request, z.object({}).strict());
      return Response.json(await plugins.updateMcp(id));
    }
    if (!mcp[2]) {
      if (request.method === "PUT") return Response.json(await plugins.saveMcp(id, await body(request, SaveMcpBody)));
      if (request.method === "PATCH") { plugins.enableMcp(id, (await body(request, PluginEnabledBody)).enabled); return new Response(null, { status: 204 }); }
      if (request.method === "DELETE") { plugins.removeMcp(id); return new Response(null, { status: 204 }); }
    }
  }
  const skill = route.match(/^\/skills\/([^/]+)$/);
  if (skill) {
    const id = decodeURIComponent(skill[1]!);
    if (request.method === "PATCH") { plugins.enableSkill(id, (await body(request, PluginEnabledBody)).enabled); return new Response(null, { status: 204 }); }
    if (request.method === "DELETE") { plugins.removeSkill(id); return new Response(null, { status: 204 }); }
  }
  const service = route.match(/^\/accounts\/([^/]+)\/services\/([^/]+)(\/update)?$/);
  if (service) {
    const accountId = decodeURIComponent(service[1]!);
    const serviceId = decodeURIComponent(service[2]!);
    if (service[3] === "/update" && request.method === "POST") {
      await body(request, z.object({}).strict());
      await plugins.updateService(accountId, serviceId);
      return new Response(null, { status: 204 });
    }
    if (!service[3] && request.method === "DELETE") {
      await plugins.removeService(accountId, serviceId);
      return new Response(null, { status: 204 });
    }
  }
  const account = route.match(/^\/accounts\/([^/]+)(\/services)?$/);
  if (account) {
    const id = decodeURIComponent(account[1]!);
    if (account[2] === "/services" && request.method === "PATCH") {
      const input = await body(request, PluginServiceBody);
      return Response.json(await plugins.enableService(id, input.serviceId, input.enabled));
    }
    if (!account[2]) {
      if (request.method === "PATCH") { plugins.labelAccount(id, (await body(request, PluginAccountBody)).label); return new Response(null, { status: 204 }); }
      if (request.method === "DELETE") { plugins.disconnectAccount(id); return new Response(null, { status: 204 }); }
    }
  }
  throw new HttpError(404, "Unknown plugin operation");
}


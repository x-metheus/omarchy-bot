import { z, type ZodTypeAny } from "zod";
import {
  AuthorizePluginBody, InstallSkillBody, PLUGIN_OPERATIONS, PluginAccountBody, PluginEnabledBody, PluginServiceBody, SaveMcpBody,
  type PluginAction,
} from "@omarchy-bot/protocol";
import { HttpError } from "../bots/bots.ts";
import type { PluginsService } from "./plugins.ts";

export interface PluginCall {
  id?: string;
  serviceId?: string;
  query?: string;
  cursor?: string;
  view?: string;
  source?: string;
  skillPath?: string;
  ref?: string;
  enabled?: boolean;
  providerId?: z.infer<typeof AuthorizePluginBody>["providerId"];
  accountId?: string;
  returnUrl?: string;
  /** Set only by manage_plugins. HTTP responses stay the route status. */
  tool?: boolean;
  signal?: AbortSignal;
  label?: string;
  connection?: z.input<typeof SaveMcpBody>;
  redirectUrl?: string;
}

type Handler = (plugins: PluginsService, call: PluginCall) => Promise<unknown> | unknown;

interface DispatchRow {
  action: PluginAction;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: ZodTypeAny;
  tool: boolean;
  empty: boolean;
  created: boolean;
  handler: Handler;
}

const text = (value: string | undefined, message: string): string => {
  if (!value) throw new HttpError(400, message);
  return value;
};

/** One row per daemon route. HTTP matching and manage_plugins both call `handler`. */
export const PLUGIN_DISPATCH: DispatchRow[] = [
  { action: "list", method: "GET", path: "/api/plugins", tool: true, empty: false, created: false, handler: (plugins) => plugins.state() },
  { action: "inspect", method: "GET", path: "/api/plugins/inspect", tool: true, empty: false, created: false, handler: async (plugins, call) => {
    const state = await plugins.state();
    const found = [...state.skills, ...state.mcp, ...state.accounts].find((entry) => entry.id === text(call.id, "Select an exact plugin id from list or search"));
    if (!found) throw new HttpError(404, "Plugin not found");
    return found;
  } },
  { action: "inspect_skill", method: "GET", path: "/api/plugins/catalog/detail", tool: true, empty: false, created: false, handler: (plugins, call) => plugins.detail(text(call.id, "Select an exact plugin id from list or search")) },
  { action: "search_skills", method: "GET", path: "/api/plugins/catalog", tool: true, empty: false, created: false, handler: (plugins, call) => plugins.catalog(call.query ?? "", call.cursor, call.view ?? "trending") },
  { action: "install_skill", method: "POST", path: "/api/plugins/skills", body: InstallSkillBody, tool: true, empty: false, created: true, handler: (plugins, call) => {
    const parsed = InstallSkillBody.parse(call.source ? { source: call.source, ...(call.skillPath === undefined ? {} : { skillPath: call.skillPath }), ...(call.ref === undefined ? {} : { ref: call.ref }) } : { id: text(call.id, "Select an exact plugin id from list or search") });
    return plugins.installSkill(parsed);
  } },
  { action: "enable_skill", method: "PATCH", path: "/api/plugins/skills/:id", body: PluginEnabledBody, tool: true, empty: true, created: false, handler: (plugins, call) => { const id = text(call.id, "Select an exact plugin id from list or search"); plugins.enableSkill(id, enabled(call)); return plugins.skills.list().find((entry) => entry.id === id); } },
  { action: "remove_skill", method: "DELETE", path: "/api/plugins/skills/:id", tool: true, empty: true, created: false, handler: (plugins, call) => { plugins.removeSkill(text(call.id, "Select an exact plugin id from list or search")); return { removed: true }; } },
  { action: "update_skills", method: "POST", path: "/api/plugins/skills/update", body: z.object({}).strict(), tool: true, empty: true, created: false, handler: async (plugins) => { await plugins.updateSkills(); return plugins.state(); } },
  { action: "authorize_service", method: "POST", path: "/api/plugins/authorize", body: AuthorizePluginBody, tool: true, empty: false, created: false, handler: async (plugins, call) => {
    if (!call.providerId || !call.returnUrl) throw new HttpError(400, "Specify the provider id");
    const authorization = await plugins.authorize({ providerId: call.providerId, returnUrl: call.returnUrl, ...(call.accountId === undefined ? {} : { accountId: call.accountId }), ...(call.serviceId === undefined ? {} : { serviceId: call.serviceId }) });
    return call.tool ? { ...authorization, pendingAuthorization: true } : authorization;
  } },
  { action: "enable_service", method: "PATCH", path: "/api/plugins/accounts/:id/services", body: PluginServiceBody, tool: true, empty: false, created: false, handler: (plugins, call) => {
    const parsed = PluginServiceBody.parse({ serviceId: text(call.serviceId, "Select an exact Service id from list"), enabled: enabled(call) });
    return plugins.enableService(text(call.id, "Select an exact plugin id from list or search"), parsed.serviceId, parsed.enabled);
  } },
  { action: "remove_service", method: "DELETE", path: "/api/plugins/accounts/:id/services/:serviceId", tool: true, empty: true, created: false, handler: async (plugins, call) => { await plugins.removeService(text(call.id, "Select an exact plugin id from list or search"), text(call.serviceId, "Select an exact Service id from list")); return { removed: true }; } },
  { action: "update_service", method: "POST", path: "/api/plugins/accounts/:id/services/:serviceId/update", body: z.object({}).strict(), tool: true, empty: true, created: false, handler: async (plugins, call) => { await plugins.updateService(text(call.id, "Select an exact plugin id from list or search"), text(call.serviceId, "Select an exact Service id from list")); return { completed: true, state: await plugins.state() }; } },
  { action: "label_account", method: "PATCH", path: "/api/plugins/accounts/:id", body: PluginAccountBody, tool: true, empty: true, created: false, handler: async (plugins, call) => { plugins.labelAccount(text(call.id, "Select an exact plugin id from list or search"), text(call.label?.trim(), "Specify a nonblank account label")); return (await plugins.state()).accounts.find((entry) => entry.id === call.id); } },
  { action: "disconnect_account", method: "DELETE", path: "/api/plugins/accounts/:id", tool: true, empty: true, created: false, handler: (plugins, call) => { plugins.disconnectAccount(text(call.id, "Select an exact plugin id from list or search")); return { disconnected: true }; } },
  { action: "save_mcp", method: "POST", path: "/api/plugins/mcp", body: SaveMcpBody, tool: true, empty: false, created: true, handler: (plugins, call) => { if (!call.connection) throw new HttpError(400, "Provide a complete connection definition"); return plugins.saveMcp(call.id ?? null, call.connection, call.signal); } },
  { action: "save_mcp", method: "PUT", path: "/api/plugins/mcp/:id", body: SaveMcpBody, tool: false, empty: false, created: false, handler: (plugins, call) => plugins.saveMcp(text(call.id, "Select an exact plugin id from list or search"), SaveMcpBody.parse(call.connection), call.signal) },
  { action: "update_mcp", method: "POST", path: "/api/plugins/mcp/:id/update", body: z.object({}).strict(), tool: true, empty: false, created: false, handler: (plugins, call) => plugins.updateMcp(text(call.id, "Select an exact plugin id from list or search"), call.signal) },
  { action: "enable_mcp", method: "PATCH", path: "/api/plugins/mcp/:id", body: PluginEnabledBody, tool: true, empty: true, created: false, handler: (plugins, call) => { const id = text(call.id, "Select an exact plugin id from list or search"); plugins.enableMcp(id, enabled(call)); return plugins.packages.list().find((entry) => entry.id === id); } },
  { action: "remove_mcp", method: "DELETE", path: "/api/plugins/mcp/:id", tool: true, empty: true, created: false, handler: (plugins, call) => { plugins.removeMcp(text(call.id, "Select an exact plugin id from list or search")); return { removed: true }; } },
  { action: "check_mcp", method: "POST", path: "/api/plugins/mcp/:id/check", tool: true, empty: false, created: false, handler: (plugins, call) => plugins.checkMcp(text(call.id, "Select an exact plugin id from list or search")) },
  { action: "authorize_mcp", method: "POST", path: "/api/plugins/mcp/:id/authorize", body: z.object({ redirectUrl: z.string().url().max(8192).optional() }).strict(), tool: true, empty: false, created: false, handler: (plugins, call) => plugins.authorizeMcp(text(call.id, "Select an exact plugin id from list or search"), call.redirectUrl) },
];

function enabled(call: PluginCall): boolean {
  if (call.enabled === undefined) throw new HttpError(400, "Specify enabled explicitly");
  return call.enabled;
}

const rows = [...PLUGIN_DISPATCH].sort((a, b) => b.path.length - a.path.length);

export function matchPluginDispatch(method: string, pathname: string): { row: DispatchRow; ids: { id?: string; serviceId?: string } } | undefined {
  for (const row of rows) {
    if (row.method !== method) continue;
    const names: string[] = [];
    const pattern = row.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => { names.push(name); return "([^/]+)"; });
    const matched = new RegExp(`^${pattern}$`).exec(pathname);
    if (!matched) continue;
    const ids: { id?: string; serviceId?: string } = {};
    names.forEach((name, index) => {
      const value = decodeURIComponent(matched[index + 1] ?? "");
      if (name === "id") ids.id = value;
      if (name === "serviceId") ids.serviceId = value;
    });
    return { row, ids };
  }
  return undefined;
}

export function toolOperation(action: string): DispatchRow | undefined {
  return PLUGIN_DISPATCH.find((row) => row.action === action && row.tool);
}

export function assertDispatchCoversContract(): void {
  for (const operation of PLUGIN_OPERATIONS) {
    const row = PLUGIN_DISPATCH.find((entry) => entry.action === operation.action && entry.method === operation.method && entry.path === operation.path);
    if (!row) throw new Error(`Plugin dispatch is missing ${operation.method} ${operation.path}`);
  }
}

assertDispatchCoversContract();

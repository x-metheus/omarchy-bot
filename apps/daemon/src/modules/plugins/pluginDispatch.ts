import { z, type ZodTypeAny } from "zod";
import {
  AuthorizePluginBody, InstallSkillBody, PLUGIN_OPERATIONS, PluginAccountBody, PluginEnabledBody, PluginServiceBody, SaveMcpBody,
  type PluginAction, type PluginOperation,
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
  method: PluginOperation["method"];
  path: string;
  body?: ZodTypeAny;
  upstream?: string;
  tool: boolean;
  empty: boolean;
  created: boolean;
  handler: Handler;
}

const text = (value: string | undefined, message: string): string => {
  if (!value) throw new HttpError(400, message);
  return value;
};

const handlers: Record<PluginAction, Handler> = {
  list: (plugins) => plugins.state(),
  inspect: async (plugins, call) => {
    const state = await plugins.state();
    const found = [...state.skills, ...state.mcp, ...state.accounts].find((entry) => entry.id === text(call.id, "Select an exact plugin id from list or search"));
    if (!found) throw new HttpError(404, "Plugin not found");
    return found;
  },
  inspect_skill: (plugins, call) => plugins.detail(text(call.id, "Select an exact plugin id from list or search")),
  search_skills: (plugins, call) => plugins.catalog(call.query ?? "", call.cursor, call.view ?? "trending"),
  install_skill: (plugins, call) => {
    const parsed = InstallSkillBody.parse(call.source ? { source: call.source, ...(call.skillPath === undefined ? {} : { skillPath: call.skillPath }), ...(call.ref === undefined ? {} : { ref: call.ref }) } : { id: text(call.id, "Select an exact plugin id from list or search") });
    return plugins.installSkill(parsed);
  },
  enable_skill: (plugins, call) => { const id = text(call.id, "Select an exact plugin id from list or search"); plugins.enableSkill(id, enabled(call)); return plugins.skills.list().find((entry) => entry.id === id); },
  remove_skill: (plugins, call) => { plugins.removeSkill(text(call.id, "Select an exact plugin id from list or search")); return { removed: true }; },
  update_skills: async (plugins) => { await plugins.updateSkills(); return plugins.state(); },
  authorize_service: async (plugins, call) => {
    if (!call.providerId || !call.returnUrl) throw new HttpError(400, "Specify the provider id");
    const authorization = await plugins.authorize({ providerId: call.providerId, returnUrl: call.returnUrl, ...(call.accountId === undefined ? {} : { accountId: call.accountId }), ...(call.serviceId === undefined ? {} : { serviceId: call.serviceId }) });
    return call.tool ? { ...authorization, pendingAuthorization: true } : authorization;
  },
  enable_service: (plugins, call) => {
    const parsed = PluginServiceBody.parse({ serviceId: text(call.serviceId, "Select an exact Service id from list"), enabled: enabled(call) });
    return plugins.enableService(text(call.id, "Select an exact plugin id from list or search"), parsed.serviceId, parsed.enabled);
  },
  remove_service: async (plugins, call) => { await plugins.removeService(text(call.id, "Select an exact plugin id from list or search"), text(call.serviceId, "Select an exact Service id from list")); return { removed: true }; },
  update_service: async (plugins, call) => { await plugins.updateService(text(call.id, "Select an exact plugin id from list or search"), text(call.serviceId, "Select an exact Service id from list")); return { completed: true, state: await plugins.state() }; },
  label_account: async (plugins, call) => { plugins.labelAccount(text(call.id, "Select an exact plugin id from list or search"), text(call.label?.trim(), "Specify a nonblank account label")); return (await plugins.state()).accounts.find((entry) => entry.id === call.id); },
  disconnect_account: (plugins, call) => { plugins.disconnectAccount(text(call.id, "Select an exact plugin id from list or search")); return { disconnected: true }; },
  save_mcp: (plugins, call) => { if (!call.connection) throw new HttpError(400, "Provide a complete connection definition"); return plugins.saveMcp(call.id ?? null, call.connection, call.signal); },
  update_mcp: (plugins, call) => plugins.updateMcp(text(call.id, "Select an exact plugin id from list or search"), call.signal),
  enable_mcp: (plugins, call) => { const id = text(call.id, "Select an exact plugin id from list or search"); plugins.enableMcp(id, enabled(call)); return plugins.packages.list().find((entry) => entry.id === id); },
  remove_mcp: (plugins, call) => { plugins.removeMcp(text(call.id, "Select an exact plugin id from list or search")); return { removed: true }; },
  check_mcp: (plugins, call) => plugins.checkMcp(text(call.id, "Select an exact plugin id from list or search")),
  authorize_mcp: (plugins, call) => plugins.authorizeMcp(text(call.id, "Select an exact plugin id from list or search"), call.redirectUrl),
};

const response: Partial<Record<PluginAction, { empty?: boolean; created?: boolean }>> = {
  install_skill: { created: true },
  enable_skill: { empty: true }, remove_skill: { empty: true }, update_skills: { empty: true },
  remove_service: { empty: true }, update_service: { empty: true },
  label_account: { empty: true }, disconnect_account: { empty: true },
  save_mcp: { created: true }, enable_mcp: { empty: true }, remove_mcp: { empty: true },
};

/** Contract rows plus the daemon handler. HTTP and manage_plugins both use this list. */
export const PLUGIN_DISPATCH: DispatchRow[] = PLUGIN_OPERATIONS.map((operation) => ({
  ...operation,
  tool: !("tool" in operation),
  empty: operation.method === "PUT" ? false : response[operation.action]?.empty ?? false,
  created: operation.method === "PUT" ? false : response[operation.action]?.created ?? false,
  handler: operation.method === "PUT"
    ? (plugins, call) => plugins.saveMcp(text(call.id, "Select an exact plugin id from list or search"), SaveMcpBody.parse(call.connection), call.signal)
    : handlers[operation.action],
}));

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

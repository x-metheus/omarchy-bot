/** Supported Agent execution backends. Never fork this union per Bot. */
export const AGENT_IDS = ["pi", "omp", "codex", "claude", "grok", "opencode", "gemini", "copilot", "crush"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/**
 * User-created Bot id: `bot_<32hex>`. NEVER aliases an AgentId — Bots
 * reference Agents, they are not Agents.
 */
export type BotId = string;

/** Opaque durable identity of the Computer Surface owned by one Bot. */
export type SurfaceId = string & { readonly __surfaceId: unique symbol };

export function isSurfaceId(id: string): id is SurfaceId {
  return /^surf_[0-9a-f]{32}$/.test(id);
}

/** Turn id: `turn_<32hex>`. */
export type TurnId = string;

export function isBotId(id: string): boolean {
  return /^bot_[0-9a-f]{32}$/.test(id);
}

/** Local Sidecar install id: `dev_<32hex>`. */
export type DeviceId = string;

export function isDeviceId(id: string): boolean {
  return /^dev_[0-9a-f]{32}$/.test(id);
}

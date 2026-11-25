export const AGENT_CAPABILITY_INVENTORY_VERSION = 4 as const;

export const NATIVE_THREAD_ACTIONS = ["resume", "history", "close", "rename", "delete", "fork", "compact"] as const;
export type NativeThreadAction = (typeof NATIVE_THREAD_ACTIONS)[number];

/** Versioned facts reported by an adapter about behavior its native surface actually supports. */
export interface AgentCapabilityInventory {
  version: typeof AGENT_CAPABILITY_INVENTORY_VERSION;
  steering: boolean;
  abort: boolean;
  /** Whether the adapter exposes the exact bounded send_bot_message tool contract. */
  botMail: boolean;
  /** Managed skill snapshots and turn-bound external tool calls. */
  plugins: boolean;
  nativeThreadActions: NativeThreadAction[];
  thinking: {
    supported: boolean;
    streaming: boolean;
  };
  attachments: {
    text: boolean;
    image: boolean;
    /** Adapter input bound for inlined text. Omitted when only the daemon upload bound applies. */
    maxTextBytes?: number;
  };
  /** Exact capability identifiers permitted on residual `native` events. */
  nativeEventFamilies: string[];
}

const AGENT_CAPABILITY_INVENTORY_KEYS: Record<string, true> = {
  version: true,
  steering: true,
  abort: true,
  botMail: true,
  plugins: true,
  nativeThreadActions: true,
  thinking: true,
  attachments: true,
  nativeEventFamilies: true,
};

const THINKING_CAPABILITY_KEYS: Record<string, true> = { supported: true, streaming: true };
const ATTACHMENT_CAPABILITY_KEYS: Record<string, true> = {
  text: true,
  image: true,
  maxTextBytes: true,
};

export function isAgentCapabilityInventory(value: unknown): value is AgentCapabilityInventory {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const inventory = value as Partial<AgentCapabilityInventory>;
  const attachments = inventory.attachments as Partial<AgentCapabilityInventory["attachments"]> | null | undefined;
  const thinking = inventory.thinking as Partial<AgentCapabilityInventory["thinking"]> | null | undefined;
  return Object.keys(value).every((key) => key in AGENT_CAPABILITY_INVENTORY_KEYS) &&
    inventory.version === AGENT_CAPABILITY_INVENTORY_VERSION &&
    typeof inventory.steering === "boolean" &&
    typeof inventory.abort === "boolean" &&
    typeof inventory.botMail === "boolean" &&
    typeof inventory.plugins === "boolean" &&
    Array.isArray(inventory.nativeThreadActions) &&
    inventory.nativeThreadActions.every((action) => NATIVE_THREAD_ACTIONS.includes(action)) &&
    new Set(inventory.nativeThreadActions).size === inventory.nativeThreadActions.length &&
    thinking !== null &&
    thinking !== undefined &&
    Object.keys(thinking).every((key) => key in THINKING_CAPABILITY_KEYS) &&
    typeof thinking.supported === "boolean" &&
    typeof thinking.streaming === "boolean" &&
    (!thinking.streaming || thinking.supported) &&
    attachments !== null &&
    attachments !== undefined &&
    Object.keys(attachments).every((key) => key in ATTACHMENT_CAPABILITY_KEYS) &&
    typeof attachments.text === "boolean" &&
    typeof attachments.image === "boolean" &&
    (attachments.maxTextBytes === undefined ||
      (Number.isSafeInteger(attachments.maxTextBytes) && attachments.maxTextBytes > 0)) &&
    Array.isArray(inventory.nativeEventFamilies) &&
    inventory.nativeEventFamilies.every((family) => typeof family === "string" && family.length > 0) &&
    new Set(inventory.nativeEventFamilies).size === inventory.nativeEventFamilies.length;
}

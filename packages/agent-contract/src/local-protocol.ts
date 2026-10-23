export const LOCAL_ACTIONS = ["run", "search", "read", "write", "transfer"] as const;
export type LocalActionName = (typeof LOCAL_ACTIONS)[number];

/** Daemon-authored binding installed for one active Agent turn when a Sidecar is online. */
export interface AgentLocalTurnContext {
  botId: string;
  turnId: string;
  workerSessionId: string;
}

export interface AgentLocalToolContext extends AgentLocalTurnContext {
  toolCallId: string;
}

export interface AgentLocalToolOutput {
  deviceId: string;
  hostname: string;
  text: string;
  exitCode?: number;
}

const COMMAND_MAX_LENGTH = 8_192;

const localText = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });

export const LOCAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { enum: ["run", "search", "read", "write", "transfer"] },
    target: { type: "string", minLength: 1 },
    command: localText(COMMAND_MAX_LENGTH),
    path: localText(4_096),
    destination: localText(4_096),
    query: localText(1_024),
    contents: { type: "string", maxLength: 65_536 },
    direction: { enum: ["to-workspace", "from-workspace"] },
  },
  oneOf: [
    { required: ["action", "command"], properties: { action: { const: "run" } } },
    { required: ["action", "query"], properties: { action: { const: "search" } } },
    { required: ["action", "path"], properties: { action: { const: "read" } } },
    { required: ["action", "path"], properties: { action: { const: "write" } } },
    { required: ["action", "path", "destination", "direction"], properties: { action: { const: "transfer" } } },
  ],
};

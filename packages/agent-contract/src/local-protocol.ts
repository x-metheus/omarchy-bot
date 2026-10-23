import { Type } from "typebox";

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

const localText = (maxLength: number) => Type.String({ minLength: 1, maxLength });

export const LOCAL_SCHEMA = Type.Object({
  action: Type.Union(LOCAL_ACTIONS.map((action) => Type.Literal(action))),
  target: Type.Optional(Type.String({ minLength: 1 })),
  command: Type.Optional(localText(COMMAND_MAX_LENGTH)),
  path: Type.Optional(localText(4_096)),
  destination: Type.Optional(localText(4_096)),
  query: Type.Optional(localText(1_024)),
  contents: Type.Optional(Type.String({ maxLength: 65_536 })),
  direction: Type.Optional(Type.Union([Type.Literal("to-workspace"), Type.Literal("from-workspace")])),
}, {
  additionalProperties: false,
  oneOf: [
    { required: ["action", "command"], properties: { action: Type.Literal("run") } },
    { required: ["action", "query"], properties: { action: Type.Literal("search") } },
    { required: ["action", "path"], properties: { action: Type.Literal("read") } },
    { required: ["action", "path"], properties: { action: Type.Literal("write") } },
    { required: ["action", "path", "destination", "direction"], properties: { action: Type.Literal("transfer") } },
  ],
});

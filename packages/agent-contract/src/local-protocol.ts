import { Type } from "typebox";
import { Value } from "typebox/value";

export const LOCAL_DEVICE_OS = ["linux", "macos", "windows"] as const;
export const LOCAL_DEVICE_SHELLS = ["posix-sh", "powershell-5.1"] as const;
export interface LocalDeviceIdentity {
  os: (typeof LOCAL_DEVICE_OS)[number];
  shell: (typeof LOCAL_DEVICE_SHELLS)[number];
}

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
export const LOCAL_COMMAND_MAX_LENGTH = 8_192;
export const LOCAL_CONTENTS_MAX_LENGTH = 65_536;

const localText = (maxLength: number) => Type.String({ minLength: 1, maxLength });

export const LOCAL_SCHEMA = Type.Object({
  action: Type.Union(LOCAL_ACTIONS.map((action) => Type.Literal(action))),
  target: Type.Optional(Type.String({ minLength: 1 })),
  command: Type.Optional(localText(LOCAL_COMMAND_MAX_LENGTH)),
  path: Type.Optional(localText(4_096)),
  destination: Type.Optional(localText(4_096)),
  query: Type.Optional(localText(1_024)),
  contents: Type.Optional(Type.String({ maxLength: LOCAL_CONTENTS_MAX_LENGTH })),
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

export interface LocalJob {
  action: "run" | "search" | "read" | "write" | "transfer";
  target?: string;
  command?: string;
  path?: string;
  destination?: string;
  query?: string;
  contents?: string;
  direction?: "to-workspace" | "from-workspace";
}

export function isLocalJob(value: unknown): value is LocalJob {
  return Value.Check(LOCAL_SCHEMA, value);
}

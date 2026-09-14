export interface AgentLocalToolDefinition {
  readonly name: "local";
  readonly description: string;
  readonly systemPrompt: {
    readonly summary: string;
    readonly guidelines: readonly string[];
  };
}

/** Plugin-owned OS work on a named Local Sidecar. Not native shell and not Bot Screen control. */
export const AGENT_LOCAL_TOOL: AgentLocalToolDefinition = Object.freeze({
  name: "local",
  description:
    "Run commands and file work on an online Local Sidecar (this-device or an explicit device identity). Use local for off-host shell, search, read, write, and Shared Workspace transfer. Never use local for screenshots, pointer, Takeover, or Host Session compositor IPC. Unqualified GUI still uses computer on this Bot Screen. If local is unavailable or the device is offline, report that failure; never fall back to native bash or the Host Session.",
  systemPrompt: Object.freeze({
    summary: "Operate the named Local Sidecar OS, never the Host Session or this Bot Screen.",
    guidelines: Object.freeze([
      "local is offered only while a Local Sidecar is online. this-device is the Sidecar belonging to the Omarchy Bot that sent the current user message.",
      "Use local.run for host commands including Docker, compose, package installs, and starting or stopping applications. That is not Screen control and must not open, click, or screenshot the Host Session.",
      "Use local.search, local.read, local.write, and local.transfer for Sidecar files. Shared Workspace stays on the plugin host; writes on the Sidecar need explicit paths.",
      "If the target device is missing, offline, or ambiguous, fail or ask. Never proxy native bash, files, MCP, or Skills onto a Sidecar, and never fall back to the Host Session.",
    ]),
  }),
});

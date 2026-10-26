# Agent adapters and native capability inventory

> Inventory date: 2026-09-04. Every implementation entry must be verified against the installed Agent version and its official interface before the Agent is enabled.

## Policy

An Agent is an execution backend; it is not a visible Bot. User-created Bots reference an Agent, and multiple Bots may use the same Agent.

Each adapter maintains a versioned **Agent Capability Inventory**. The inventory is descriptive evidence, not a permission manifest, feature allowlist, or reason to alter native Agent behavior. Omarchy Bot:

- chooses the richest official integration surface available;
- preserves native events and controls rather than reducing every Agent to the smallest common protocol;
- does not inject an independent `ask`/`trusted` policy or approval gate;
- treats Native Sessions as Agent-owned, so Bot deletion removes local mappings without invoking an Agent worker or deleting native data;
- marks an Agent unavailable when its installed version fails its adapter conformance suite.

Working-directory and desktop bindings follow the [Shared Workspace and plugin boundary](workspace-redesign.md#shared-workspace-and-plugin-boundary). A Native Session, the shared Bot Computer, a routed Bot Screen, and a Screen Projection are different lifetimes: changing the viewed Bot does not end its Agent or graphical work. The shared default cwd is `~/.omarchy-bot/workspace`; application/browser profile state is shared inside the private Bot Computer; the Service does not add work-file locks or application-internal synchronization.

## Adapter baseline

A usable conversation adapter must prove the operations required by its own official lifecycle:

- create and restore a conversation/session;
- send user content and stream output;
- preserve ordered Response, Thinking, Tool Call, and residual Native Events;
- reach explicit completed, cancelled, and failed boundaries;
- cancel an active turn through the Agent's native mechanism;
- accept the attachment forms claimed by that adapter;
- close and recover without orphaning the worker.

Steer, fork, compact, rename, Thread delete, subagents, plans, usage, and other advanced operations are inventory entries, not fabricated common features. A capability-specific product surface may expose them only after their common semantics and tested support are defined; raw Native Events are not a substitute.

## Official integration surfaces

| Agent | Primary official surface | Adapter state | Notes |
| --- | --- | --- | --- |
| Pi | `@earendil-works/pi-coding-agent` TypeScript SDK | Implemented | Native sessions, Response and Thinking block streams, tools, internal abort, history, attachments, and SDK steering are available. |
| OMP | `@oh-my-pi/pi-coding-agent` Bun SDK | Pending | Use the in-process SDK behind an isolated Bun worker; preserve extensions, skills, tools, and session events. |
| Codex | `codex app-server --stdio` | Pending | Use `thread/start|resume`, `turn/start|interrupt`, generated protocol types, and structured server events. |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | Pending | Use `query()`, async multi-turn input, resume, interrupt, hooks, partial messages, and native tool decisions. |
| Grok Build | native ACP plus `x.ai/*` extensions | Pending | Basic ACP alone is incomplete. Preserve Grok session, steering, queue, fork, compact, subagent, workspace, and other advertised extensions by version. |
| OpenCode | `@opencode-ai/sdk` plus local server | Pending | Preserve server events and native session children, share, summarize, revert, commands, files, and LSP operations. |
| Gemini CLI | `gemini --acp` | Pending | Use ACP negotiation, session lifecycle, content/tool updates, permission requests, and native image/file support. |
| GitHub Copilot CLI | `@github/copilot-sdk` with explicit native runtime | Pending | Preserve sessions, steering/queueing, hooks, elicitation, subagents, usage, workspace, and attachment events. |
| Crush | official Unix-socket HTTP/SSE server | Pending | Keep the workspace SSE connection alive and correlate workspace, session, run, tool, question, and cancellation results. |

`Pending` Agents remain visible but disabled in the Agent picker with setup/status guidance. Presence on `PATH` alone is not readiness.

## Capability inventory format

Every adapter owns a machine-readable record tied to the exact Agent version:

```ts
interface AgentCapabilityInventory {
  version: 4;
  steering: boolean;
  abort: boolean;
  botMail: boolean;
  plugins: boolean;
  thinking: {
    supported: boolean;
    streaming: boolean;
  };
  nativeThreadActions: Array<
    "resume" | "history" | "close" | "rename" | "delete" | "fork" | "compact"
  >;
  attachments: {
    text: boolean;
    image: boolean;
    maxTextBytes?: number;
  };
  nativeEventFamilies: string[];
}
```

Rules:

1. A claimed operation or modality means the official interface was exercised by conformance, not merely documented. `botMail: true` specifically means the adapter exposes the exact bounded `send_bot_message` custom tool; adapters without that contract report `false`.
2. `false` or an absent action is honest unavailability and must not trigger an emulated substitute.
3. Response, Thinking, Tool Call, Turn, and error semantics are normalized before an event may be classified as Native.
4. Unknown public Native Event payloads may be retained for fidelity. Diagnostic and secret payloads retain redacted metadata only, and no generic raw Native Event renderer appears in the Thread.
5. Upgrading the Agent invalidates the previous readiness record and inventory until conformance passes again.
6. Feature UI and daemon services read this inventory as the sole source for support decisions; it never approves or denies Agent tools.

## Worker boundary

Vendor SDKs and protocols run behind supervised local workers. The daemon/worker contract carries correlated commands and normalized events while preserving native envelopes:

```ts
type AgentCommand =
  | { type: "probe"; requestId: string }
  | { type: "session.open"; requestId: string; botId: string; threadId: string; options: OpenSessionOptions }
  | { type: "session.resume"; requestId: string; botId: string; threadId: string; nativeSessionId: string; options: OpenSessionOptions }
  | { type: "message.send"; requestId: string; sessionId: string; turnId: string; message: UserMessage }
  | { type: "message.steer"; requestId: string; sessionId: string; text: string }
  | { type: "turn.abort"; requestId: string; sessionId: string }
  | { type: "session.history"; requestId: string; sessionId: string }
  | { type: "session.close"; requestId: string; sessionId: string };
```

The exact accepted commands are versioned. An adapter may report an operation unavailable; it may not silently route it through a weaker headless or PTY transport.

### Native plugin discovery and runtime

`plugins: true` describes the adapter's exercised native plugin integration and
correlated inventory/configuration Tool Call bridge. Pi is the implemented
adapter; other adapters must report `false` until their integration is exercised.
The bridge is not a second business MCP runtime: Pi business MCP calls execute
only through pinned `pi-mcp-adapter@2.33.0`, never daemon-injected business tools.
The pinned dependency patch fixes Unix-socket Buffer addressing, publishes
`needs-auth` status after a gateway connection attempt, and preserves native
OAuth refresh-lock exclusion under Bun/Linux. Bun cannot safely call the native
fd-lock binding directly; an inherited-descriptor Node helper acquires the same
Linux open-file-description lock retained by the parent. **Node must be on PATH**;
there is no lock bypass or host-global dependency installation.
`@omarchy-bot/agent-contract/native-mcp-revision` is server-only; keep its Node
filesystem/crypto dependencies out of the browser-facing package barrel.

Canonical shared Skills live at `~/.omarchy-bot/workspace/.agents/skills`, with
native client discovery links where needed. User-level and externally configured
resources retain native precedence and remain read-only in the panel. Custom
project MCP entries are reconciled conservatively across `.mcp.json`,
`.pi/mcp.json`, and `.codex/config.toml`; unrelated settings are preserved and
conflicts or client-specific limits are visible. Credentials stay in private
application/native-client stores, not shared files, Client read DTOs, or
model-visible output. Credential inputs remain write-only.

Reload follows the native session/extension lifecycle. Native file resources are
mutable, with no blanket per-Turn immutable Skill revision lease. Disabling or
removing resources applies at the applicable native boundary without aborting
unrelated Turns. The shared default cwd and explicit Thread cwd behavior are
unchanged. Services use official MCP connections and companions only, with no
REST business fallback; provider-specific setup and separate external-client
login remain necessary.
Enabled remote Skills and official companion resources use the same staged
updater. MCP package ownership is explicit: save either a native `transport`
(stdio command or HTTP endpoint) or a `package` containing an exact public npm
`name` without a version suffix, optional `bin`, `args`, and write-only `env`.
These are mutually exclusive inputs. Opaque native commands remain supported
first-class definitions; the product never guesses package identity from `npx`,
shell arguments, or an executable path.

Managed npm packages resolve `latest` and install privately under product-owned
storage, never into host/global package installations. Node 24+ on PATH is required
to run their validated Node-compatible entrypoints. The Linux launcher uses
Node's experimental [`process.execve` API](https://nodejs.org/api/process.html#processexecvefile-args-env) to replace itself while retaining its
PID, start time, and stdio; no extra business protocol or idle supervisor remains.
Packages or dependencies declaring `preinstall`, `install`, or `postinstall`
hooks are unsupported; installation never runs those hooks. Package read DTOs
expose the selected binary and arguments,
installed/available versions, modification state, last check, and update status
(`current`, `modified`, `failed`, or `available`); environment values remain
write-only and only saved key names are exposed.
Changing npm package identity or switching between managed and native-command
ownership clears saved environment credentials unless they are supplied again.

Automatic updates and explicit `POST /api/plugins/mcp/:id/update` requests with
an empty JSON object use the same ownership and safety rules. Clean replacements
are staged, with local content rechecked before activation; local modifications
block replacement and failures retain the prior usable installation. Updates
respect native reload boundaries without forcibly terminating Active Turns or
swapping their in-use tool registry. Obsolete package processes and installations
are released only when native consumers can safely let them go. Package
management does not introduce another business MCP runtime. The bundled adapter
changes with the product runtime; hosted MCP deployments remain provider-owned
and are not locally pinnable or roll-backable packages.

The official OpenAI Skill Creator, complete companion resources, and vendored
PyYAML are supplied locally for native file/execution-based creation. Ordinary
Python 3 is required; Pi creation requires neither Codex/Claude installation nor
their credentials. There is no publication, registration, or authoring service.
See the [native plugin specification and upstream references](../.scratch/shared-plugins-native-discovery/spec.md)
and [provider setup references](../packages/protocol/src/pluginProviders.ts).
Acceptance on 2026-09-12 exercised real Pi SDK 0.84.4 / adapter 2.33.0 stdio and
HTTP tool calls, controlled headless PKCE authorization, complete Creator scripts
with bundled Python dependencies, packaged production daemon startup, and
desktop/narrow Chromium. Native Codex 0.154.0 discovery returned the same physical
shared Skills and projected MCP configuration. These observations do not prove
live provider consent/business access, native Claude/Codex model authoring, or
Tauri/WebView compatibility. See the
[installed acceptance record](../.scratch/shared-plugins-native-discovery/issues/16-installed-plugin-upgrade-and-recovery.md)
for exact evidence and unavailable prerequisites.

Adapters assign a stable common block ID at each native Response or Thinking block start and reuse it for every delta and end event. They preserve occurrence order and expose only Thinking content or provider-authored summaries officially supplied by the backend.

Tool Call events contain required identity, name, and status plus only reliably available Adapter-authored safe summaries such as target, duration, diff statistics, and a bounded redacted error. Full tool input and output are not transcript history.

Native Events carry `agentId`, capability name, payload, and sensitivity only after common semantics have been removed. Secret or diagnostic payloads are never forwarded to the browser without an explicit safe projection.

## Adapter notes

### Pi

Use `createAgentSession`, `DefaultResourceLoader`, `SessionManager.create/open`, and the SDK event subscription. Load the user's native Pi resources. Normalize Pi 0.84.4 `text_start | text_delta | text_end` and `thinking_start | thinking_delta | thinking_end` as ordered common blocks correlated from native `contentIndex`; do not change Pi's native Thinking level or infer content it does not expose. Use `session.steer(...)` for messages sent during active work and `session.abort()` only for explicit local operations that must terminate work, such as deleting an active Bot.

Pi Native Sessions are Agent-owned continuation state. Omarchy Bot does not advertise or invoke Native Session deletion; deleting a Bot leaves that native state intact.

The shared `@omarchy-bot/agent-contract` computer tool definition owns mandatory graphical guidance for every Agent adapter exposing `computer`. It distinguishes the shared private Sway Bot Computer, the owning Bot's routed Screen workspace, the user's Omarchy/Hyprland Host Session, the Agent's Native Session, and client Screen Projections. Unqualified graphical requests target the owning Bot Screen; adapters must not fall back to native shell commands, Host compositor IPC, global display variables, or host process inspection. Input may wait for the shared Bot Computer seat.

Pi maps that shared definition into its SDK-native tool description, prompt snippet, and prompt guidelines. Future adapters must map the same definition into their official tool and system-prompt surfaces rather than copying policy text. Every successful computer result includes `desktopSession` with `botId`, `surfaceId`, and `runtimeGeneration` in both model-visible text and structured tool details. The Screen manager stamps that identity within the serialized action, including the fresh observation returned after Takeover. Bot Computer recreation changes the generation without changing the Bot's Surface or conversation; restarting a Screen component reattaches under the same generation; session creation and restoration load the same shared guidance without provisioning a desktop. Socket paths remain runtime-internal, and context metadata neither selects a target nor grants input authority.

### Codex

Initialize the app-server connection and generate types matching the probed binary. Treat `turn/completed` as authoritative. Preserve native approval requests as Agent-native interaction rather than routing them through a second omarchy-bot policy.

### Claude

Use async iterable input for multi-turn operation, `resume` for continuity, and `interrupt()` for cancellation. Preserve partial messages, hooks, tool events, and the Agent's own permission behavior.

### Grok

Implement ACP initialization, authentication, session lifecycle, prompts, cancellation, content/tool/plan updates, and negotiated capabilities. Inventory the installed version's `x.ai/*` operations, including session search/history/fork/rename/delete, interject/queue controls, compact/rewind, subagents, scheduler/background events, workspace operations, and usage. Do not claim any entry until its conformance case passes.

### OpenCode, Gemini, Copilot, Crush, and OMP

Implement against the primary surfaces in the table. Preserve each interface's richer native event stream. Record exact operations and evidence during adapter implementation instead of deciding behavior through speculative product fallbacks.

## Conformance

A versioned adapter suite verifies:

1. probe and authentication/readiness;
2. session creation and restoration;
3. streamed output and explicit terminal state;
4. ordered Response and Thinking blocks, including multiple blocks around Tool Calls;
5. safe Tool Call summary and residual Native Event preservation;
6. native cancellation without late output;
7. claimed attachment types;
8. close/restart/recovery behavior;
9. every `native` capability inventory entry;
10. unknown-event drift handling;
11. Computer tool coordination where the Agent uses the shared desktop.

Only a passing record makes an installed Agent selectable.

## Primary sources

- Pi SDK 0.84.4 local docs: `docs/sdk.md`, `docs/rpc.md`
- OMP: <https://github.com/can1357/oh-my-pi/blob/master/docs/sdk.md>
- Codex app-server: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- Claude Agent SDK: <https://github.com/anthropics/claude-agent-sdk-typescript>
- Grok Build: <https://github.com/xai-org/grok-build>
- OpenCode SDK: <https://github.com/anomalyco/opencode>
- Gemini ACP: <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md>
- Copilot SDK: <https://github.com/github/copilot-sdk>
- Crush: <https://github.com/charmbracelet/crush>

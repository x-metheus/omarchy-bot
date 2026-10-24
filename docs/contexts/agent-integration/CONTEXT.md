# Agent Integration

The context for connecting supported coding-agent backends without reducing or overriding their native behavior.

## Language

Definitions only. Rules and acceptance live in [agents-integration](../../agents-integration.md), [the product boundary](../../workspace-redesign.md#native-agent-behavior), and [the current implementation specification](../../../.scratch/shared-workspace-desktop-boundary/spec.md). Related terms: [Bot](../workspace/CONTEXT.md), [Thread](../workspace/CONTEXT.md), [Shared Workspace](../workspace/CONTEXT.md), [Bot Computer](../computer-control/CONTEXT.md), [Bot Screen](../computer-control/CONTEXT.md).

**Agent**:
A supported execution backend such as Pi, Claude, or Codex that supplies a Bot's runtime capabilities. An Agent is selected when a Bot is created and is not itself shown as a user-created Bot.
_Avoid_: Bot, assistant, persona

**Agent Readiness**:
Whether an Agent can accept new work. It is independent of the activity and lifecycle of every Bot that references the Agent.
_Avoid_: Bot status, Bot availability, presence

**Native Session**:
Conversation state owned by an Agent backend, distinct from both the user's Thread and the Bot's graphical work surface. Omarchy Bot may reference it for continuation, but deleting a Bot does not erase it.
_Avoid_: Thread, Bot history, Omarchy-owned session, Bot Computer

**Thinking**:
Model reasoning content or provider-authored reasoning summary officially and natively exposed by an Agent for a Turn, available while streaming and in Thread history. It is separate from the Bot's response and from operational reasons for Agent Readiness or Turn failure.
_Avoid_: Reason, failure reason, Agent Readiness reason

**Thinking Block**:
One contiguous unit of Thinking delimited by an Agent within a Turn. A Turn may contain several Thinking Blocks interleaved in their original order with Response Blocks and Tool Calls.
_Avoid_: Turn reason, merged Thinking, Thinking delta

**Tool Call**:
An operation invoked by an Agent during a Turn, represented independently from Response Blocks, Thinking Blocks, and Agent-specific Native Events.
_Avoid_: Activity, Native Event, Thinking

**Native Event**:
An Agent-specific runtime signal left after common Response, Thinking, Tool Call, Turn, and error semantics are normalized. Unknown public payloads may be retained for fidelity, while diagnostic and secret payloads retain only redacted metadata; Native Events have no generic Thread presentation.
_Avoid_: Tool Call, Thinking, raw diagnostic

**Agent Adapter**:
The isolated integration that translates between Omarchy Bot's worker protocol and one Agent's richest official SDK or protocol surface. It preserves native lifecycle, events, and controls.
_Avoid_: Bot implementation, PTY wrapper, capability filter

**Agent Capability**:
An operation the selected Agent can already perform in the Service Host's Linux environment. Omarchy Bot preserves the Agent's native capabilities and approval behavior rather than adding, removing, filtering, or independently approving them.
_Avoid_: Bot permission, provisioned capability

**Agent Capability Inventory**:
Compact, adapter-owned metadata returned by the Agent probe. It truthfully describes native steering, abort, Thinking, Thread actions, accepted attachment modalities, and native event families for the probed Agent version. It is the sole support-policy source for UI and service behavior, not a permission manifest or a promise to emulate missing features.
_Avoid_: Bot permission, capability gate, speculative capability list

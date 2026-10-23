# 03: Deepen the turn-bound ToolChannel

**Type:** task
**Status:** resolved
**Blocked by:** 01, 02

**What to build:** Replace the four hand-copied reverse tool-call paths (`computer`, `local`, `plugin`, `send_bot_message`) with one `ToolChannel` module that has a worker half and a daemon half in `packages/agent-contract`.

Today: `workers/pi/src/worker.ts:78-225, 460-489`, `workers/pi/src/plugin-tools.ts`, `packages/agent-contract/src/{local,plugin,bot-message}-protocol.ts`, `apps/daemon/src/supervision/workerClient.ts:153-318`, `apps/daemon/src/modules/turns/turns.ts:35-54, 470-630, 800-832`, `tests/integration/fake-workers/pi/src/worker.ts`.

Decisions (settled):
- A tool supplies only `name`, a TypeBox parameter schema (single source, in `agent-contract`), and an executor `(params, { botId, turnId, toolCallId }, signal)` returning a result or throwing. The daemon half validates with TypeBox `Value.Check`; the hand-written validators go away.
- Wire: one generic `tool.request` / `tool.result` pair carrying the tool name replaces the four pairs (worker and daemon ship together).
- The channel accepts a request only for a Tool Call this Turn's Agent has **started** and that has **not yet been dispatched**; duplicates are rejected for every tool.
- Per-worker-session tool set = static tools + leased plugin tools, replaced on each new snapshot. Per-turn availability (e.g. `local` only while This Device is online) remains a predicate.
- Turn abort aborts every in-flight executor `signal`; worker session close rejects every pending worker-side call (all tools, not only plugin).
- The fake Pi worker imports the real worker half.
- Migrate tool-by-tool on one branch: `send_bot_message`, `local`, `plugin`, `computer`; each step keeps integration suites green; remove old frames and `started*`/`dispatched*` sets in the final commit.

- [x] `ToolChannel` worker + daemon halves with tests at their interface (duplicate, not-started, dispatch-once, abort, session close, schema rejection).
- [x] All four tools migrated; per-tool validators, handlers, pending maps and TurnContext sets deleted.
- [x] Fake Pi worker uses the real worker half.

## Comments

## Answer

The worker and daemon halves of `ToolChannel` now route `send_bot_message`, `local`, plugin tools, and `computer` through generic tool frames. The channel validates shared TypeBox schemas, requires a started Tool Call, dispatches it once, propagates cancellation to executors, and closes pending calls with their worker session. The fake Pi worker imports the real worker half. The former per-tool frames, handlers, pending maps, and TurnContext dispatch sets are removed.

Review approved the implementation through `e8ec2fb` (`REVIEW.md`: `APPROVED`), including the shared MCP HTTP URL validation fix.

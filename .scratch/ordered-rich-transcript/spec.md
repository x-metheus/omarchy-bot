# Ordered rich transcript

Status: resolved

## Problem Statement

Omarchy Bot currently renders user and Bot text as whitespace-preserved plain text even though Agent output contains Markdown. It also places consecutive Tool Calls and textless Native Events inside a product-owned `Activity` disclosure, then forces Astryx `ChatToolCalls` open inside that second disclosure. This hides Astryx's native single-versus-grouped behavior, presents Native Events as if they were tools, and overloads `Activity`, which already has the distinct domain meaning **Bot Activity**.

The current protocol loses Agent structure. A Turn buffers all Bot text into one final message, Pi drops native text block boundaries and Thinking events, and the public Message model has only `text | tool | event`. The Thread therefore cannot preserve a real sequence such as Response → Thinking → Tool Call → Response. Bot Profile also has no separate display preferences for users who want a quiet transcript.

## Solution

Represent Agent output as ordered Response Blocks, Thinking Blocks, Tool Calls, and recognized product content. Adapters normalize native block boundaries into stable common block IDs. The daemon persists blocks incrementally and preserves their original order; abnormal incomplete Response and Thinking Blocks are removed, while an unfinished Tool Call is retained as an error.

Render user text and Response Blocks with Astryx Markdown. Remove the outer Activity disclosure and use Astryx `ChatToolCalls` directly for adjacent Tool Calls. Render Thinking as compact Markdown in a separate, collapsed disclosure. Add per-Bot Display Settings that independently show Tool Calls and Thinking, both off by default. These settings only filter presentation: hidden content is still received and retained.

Native Events remain a typed fidelity boundary after common semantics are normalized. Unknown public payloads may be retained, diagnostic and secret payloads retain only redacted metadata, and the first release has no generic Native Event renderer. Cross-Agent concepts such as plans, usage, approvals, subagents, compaction, and background work require their own common product models before entering the Thread.

## User Stories

1. As a user, I want my messages and Bot responses rendered as Markdown, so that lists, tables, links, code, and other structured content are readable.
2. As a user, I want Bot Markdown rendered while it streams, so that formatting does not appear only after the Turn ends.
3. As a user, I want raw HTML ignored or shown as text, so that Markdown cannot inject arbitrary markup.
4. As a user, I want links to open outside the workspace, so that following one does not replace my active Thread.
5. As a user, I accept that HTTP(S) Markdown images load directly from public, private, loopback, or link-local hosts without a Referer, so that all remote image locations work.
6. As a user, I want Response, Thinking, Tool Call, and Steering content kept in occurrence order, so that history tells the truth about the Turn.
7. As a user, I want adjacent Response Blocks to read as one visual response, so that native boundaries do not create unnecessary bubble fragmentation.
8. As a user, I want Thinking shown only when the Agent officially exposes it, so that Omarchy Bot never reconstructs hidden chain-of-thought.
9. As a user, I want officially exposed raw reasoning or provider-authored reasoning summaries treated as Thinking, so that different native providers remain truthful.
10. As a user, I want each Thinking Block collapsed by default with its state and duration, so that reasoning is inspectable without dominating the Thread.
11. As a user, I want my manual Thinking expansion preserved during live updates, so that completion does not close content I am reading.
12. As a user, I want Tool Calls rendered with Astryx's native grouping, so that one call is inline and adjacent calls collapse without a second Activity wrapper.
13. As a user, I want Tool Calls to expose only safe summaries, so that full tool inputs and outputs are not retained as transcript diagnostics.
14. As a user, I want Tool Call summaries to show status and name plus only reliably available target, duration, diff statistics, and a bounded redacted error summary.
15. As a user, I want incomplete tools retained as errors when a Turn terminates abnormally, so that execution history does not claim they never started.
16. As a user, I want separate per-Bot controls for Tool Calls and Thinking, so that different teammates can have different transcript density.
17. As a user, I want both controls off by default, so that Response content remains the default focus.
18. As a user, I want display controls to affect current output and all history immediately without changing Agent behavior or retention.
19. As a user, I want Bot Display Settings to follow the Bot across windows, so that the same teammate has one presentation preference.
20. As a user, I want old Thinking to remain viewable after an Agent loses Thinking support, so that capability changes do not hide retained history.
21. As a screen-reader user, I want only Thinking and Tool Call state boundaries announced, so that streaming deltas do not overwhelm the Bot response.
22. As a user, I want Sidebar previews and unread content driven only by Bot Responses, so that hidden process records do not become conversation summaries.
23. As a user, I want a Turn with no Response to remain quiet when process content is hidden, so that the app does not invent a Bot reply.
24. As an integrator, I want provider-specific signals retained without a generic raw-event UI, so that fidelity does not turn the Thread into an engineering console.

## Implementation Decisions

- Replace Bot-authored `text` messages with `response` records and add `thinking` records. User and System text remain `text`; Tool Calls and Native Events remain distinct kinds.
- A Response or Thinking record carries a stable Adapter-generated block ID, lifecycle state, ordered sequence, content, and native start/end timing needed for presentation. The Adapter creates the common block ID at native block start and reuses it for every delta and end event.
- Common worker events represent Response and Thinking start, delta, and completion independently. Adapter output must preserve the native event order.
- Pi is the only implemented Agent in this release. Normalize Pi 0.84.4 `text_start | text_delta | text_end` and `thinking_start | thinking_delta | thinking_end`, correlating each native block by `contentIndex` behind the common block ID.
- Pi Thinking remains controlled by Pi's own session/model/settings resolution. Omarchy Bot observes what Pi officially exposes and does not enable, disable, infer, or reconstruct reasoning.
- `AgentCapabilityInventory` gains explicit Thinking support metadata, including whether streaming is available. Current capability controls new production; retained history remains viewable independently.
- Response and Thinking records are created at block start and updated during streaming. Only completed blocks enter terminal history: failure, cancellation, worker loss, daemon recovery, or any other abnormal path removes incomplete Response and Thinking records.
- A started Tool Call that lacks a terminal event when its Turn terminates is retained with `error` status and a safe interrupted summary. Completed Tool Call summaries remain until Bot Deletion.
- Tool Call events carry required ID, name, and status plus optional Adapter-authored target, duration, diff statistics, and one bounded redacted error summary. The daemon validates these projections. No layer guesses missing fields, and full tool input/output is not persisted as transcript detail.
- Only adjacent Tool Calls form one `ChatToolCalls` group. Response, Thinking, Steering, or recognized product content ends the group.
- Remove the product-owned Activity disclosure. Place `ChatToolCalls` directly inside assistant message context and let Astryx control inline-versus-grouped collapse.
- Thinking uses an independent disclosure, compact Astryx Markdown, and a header that shows `Thinking…` while active and elapsed wall-clock time after completion. Each block measures from its own start to end.
- Thinking starts collapsed. Manual expansion survives deltas and block completion for the current Thread visit, but is not persisted across refreshes.
- Adjacent Response Blocks remain separate persisted records but render as one visual filled bubble. User Markdown and Bot Markdown both use filled bubbles.
- Astryx Markdown renders user text, completed Response Blocks, live Response content with `isStreaming`, and expanded Thinking. Unsupported raw HTML is ignored or shown as text.
- Markdown links accept only safe navigation schemes, open in a new window or system browser, and use `noopener noreferrer`. Markdown images may load directly from any HTTP(S) host, including local/private addresses, with `no-referrer`; other dangerous schemes are rejected.
- Bot Settings is the existing right-side Bot surface, split into Profile and Display sections. Bot Profile retains only identity; Bot Display Settings contains `Show tool calls` and `Show Thinking`.
- Both display settings default off, are stored by the daemon in SQLite, apply across every Thread belonging to the Bot, and synchronize across windows. A switch updates optimistically, saves immediately, and rolls back with a non-blocking error if persistence fails.
- A display switch filters the current stream and all retained history immediately. It never changes Agent configuration, event receipt, persistence, Tool Call failure visibility, or retention.
- When the current Agent does not support Thinking and no retained Thinking exists, the switch is disabled with an explanation. If retained Thinking exists, it stays enabled and explains that new Turns no longer provide it.
- Sidebar previews and unread-message content use Response Blocks only. Existing Turn completion and action-needed notifications remain state-driven.
- Native Events are accepted only when declared by the exact ready Agent inventory. Unknown public payloads may be retained; diagnostic and secret payloads store only capability, sensitivity, and redacted metadata. No Native Event is rendered in the Thread in this release.
- Use the new schema directly during development. The current local development database is removed manually. Product code does not automatically delete a database, does not dual-read the old `text` format, and does not implement a legacy-message migration. Test fixtures use the new schema.
- The interface remains English-only.

## Testing Decisions

- Protocol and domain tests cover block IDs, ordered start/delta/end events, valid transitions, optional safe Tool Call summary fields, Thinking capability metadata, and rejection of undeclared event families.
- Pi conformance proves text and Thinking block boundaries, multiple blocks around Tool Calls, model-without-Thinking behavior, official summary/raw content preservation, and no hidden-reasoning reconstruction.
- Daemon integration tests prove incremental block persistence, strict sequence order, abnormal incomplete-block deletion, interrupted Tool Call finalization, safe summary retention, Bot Deletion cleanup, and Native Event sensitivity handling.
- API integration tests prove per-Bot display defaults, immediate writes, cross-window events, rollback-visible failures, all-Thread scope, and historical Thinking access after capability loss.
- Browser tests prove Markdown for user and Bot text, streaming Markdown, raw-HTML rejection, safe external links, direct no-referrer HTTP(S) images, filled bubbles, adjacent Response visual grouping, and unchanged attachment rendering.
- Browser tests prove no outer Activity disclosure; single and adjacent multi-call Astryx behavior; Thinking collapsed state, duration, manual expansion stability, current/history filtering, unsupported-state explanation, and quiet no-Response Turns.
- Accessibility tests prove state-boundary announcements without delta spam, keyboard access to disclosures and switches, focus stability, and meaningful labels.
- Sidebar tests prove that Thinking, Tool Calls, and Native Events do not replace Response previews or independently create unread content.
- Existing Activity expectations are replaced rather than retained as compatibility assertions.

## Out of Scope

- Implementing OMP, Codex, Claude, Grok, OpenCode, Gemini, Copilot, or Crush adapters.
- A generic Native Event, trace, JSON, or diagnostics renderer.
- Product models for plans, usage, approvals, subagents, compaction, background tasks, workspace events, or other future cross-Agent concepts.
- Changing Agent-native Thinking configuration, reasoning effort, token usage, permissions, approvals, steering, or tool execution.
- Persisting full Tool Call inputs, outputs, terminal logs, arbitrary JSON, or diffs beyond safe summary statistics.
- Markdown preview or rich-text editing in the Composer.
- Remembering individual disclosure expansion across refreshes.
- Migrating or dual-reading the current development message schema.

## Further Notes

- This specification supersedes the transcript Activity decisions in [workspace-redesign.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md) section 9, stories 60–62 of `.scratch/ai-teammate-workspace/spec.md`, and the Activity-specific acceptance criteria in its resolved ticket 02. Those documents remain historical evidence of the previous implementation.
- `Activity` is not retained as a transcript term. **Bot Activity** continues to mean only whether a Bot has an Active Turn.
- Astryx 0.5.2 provides `Markdown` and `ChatToolCalls` but no Thinking or Agent-event primitive. Thinking disclosure is composed from ordinary Astryx primitives.
- The accepted direct-load image policy can trigger blind HTTP(S) GET requests to public, private, loopback, or link-local hosts when a Thread is opened. Same-origin protections prevent response reading but do not prevent the request; this is an explicit accepted product boundary.

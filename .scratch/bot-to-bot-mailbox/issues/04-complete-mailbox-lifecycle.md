# 04: Complete mailbox lifecycle and user acceptance

**What to build:** Make Bot mail behave correctly through rename, direct permanent deletion, invalid addressing, and failure, then complete the user-facing 1:1 workflow and documentation without adding groups, attachments, RPC, or a hidden inbox. Bots remain active mailbox identities until direct permanent deletion; this ticket does not reintroduce a reversible hidden lifecycle.

**Blocked by:** 03: Recover queued mail across readiness and restart.

**Status:** resolved

- [x] New sends to missing, deleting, or identical target Bots fail with bounded safe errors and create no delivery artifacts.
- [x] A target remains eligible for mail until direct permanent deletion begins; the deletion claim rejects concurrent new sends.
- [x] Permanent target deletion removes its queued deliveries and target-owned exchange Threads under existing deletion guarantees.
- [x] Source Bot rename or deletion does not rewrite or delete target-owned history; the immutable source-name snapshot remains visible and the live source reference becomes absent after deletion.
- [x] Races between enqueue and direct permanent deletion preserve referential integrity and never create hidden work for a deleted Bot.
- [x] Self-send, group payloads, attachments, oversized text, public-network requests, and attempts to inject raw paths are rejected in v1.
- [x] Other Agent adapters advertise Bot-mail support only when they implement the custom tool contract honestly; no application approval gate is introduced.
- [x] Existing system notes, ordinary user Threads, Sidebar attention, History, and ordered transcript behavior remain unchanged outside peer-mail exchanges.
- [x] Browser end-to-end coverage proves the visible 1:1 send result, target unread navigation, target response, sender rename/deletion attribution, error presentation, and accessible light/dark behavior.
- [x] Integration coverage proves direct target/source deletion behavior, lifecycle races, validation bounds, and no regression to unrelated active target work.
- [x] User documentation includes a runnable 1:1 Bot-mail example and explains asynchronous acknowledgement, target-owned Threads, privacy, and reply-as-a-new-send semantics.

## Answer

Completed the mailbox lifecycle under direct permanent deletion. Oversized text fails tool parameter validation with `tool params do not match send_bot_message`; raw-path target IDs pass shape validation and are rejected by `MailboxService` with `target Bot ID is invalid`. Self, missing, and deleting targets retain their bounded domain errors. No rejected request creates a delivery or target Thread. Source rename and deletion preserve the immutable sender-name snapshot while deletion removes the live source reference, and target deletion continues to cascade queued deliveries and target-owned exchange Threads.

The browser scenario now drives the product UI for the complete visible flow: durable acknowledgement, target unread navigation and ordered response, source rename through Bot Settings, direct permanent deletion through the Sidebar action, preserved sender attribution, a bounded dismissible invalid-send error, History, and light/dark rendering. The raw-path failure is feasible through the public Composer because the E2E Agent fixture invokes the same Bot tool. Arbitrary oversized, group, and attachment worker payloads remain at daemon integration and Pi tool/protocol conformance seams: the browser can ask a Bot to invoke a tool, but it cannot author the untrusted worker protocol shape directly.

README documents the real local asynchronous 1:1 contract: queue acknowledgement returns immediately, the target owns the resulting Thread, source state stays private, and a reply is a new send. The accepted spec and current ticket contain no archive or restore contract, and the dead mailbox restoration hook was removed.

Validation:

- `bun test tests/integration/bot-mailbox.test.ts` — 14 pass, 0 fail, 83 expect() calls; 14 tests across 1 file in 62.41s.
- `bun test tests/conformance/pi-bot-message-tool.test.ts` — 3 pass, 0 fail, 13 expect() calls; 3 tests across 1 file in 274ms.
- `bunx playwright test -c tests/e2e tests/e2e/specs/15-bot-mailbox.spec.ts` — 1 passed in 10.0s (Chromium; complete public mailbox flow).
- `bun test packages/agent-contract/src/agent-protocol.test.ts tests/integration/agent-capabilities.test.ts` — 10 pass, 0 fail, 65 expect() calls; 10 tests across 2 files in 6.79s.
- `bun test tests/integration/bot-lifecycle.test.ts tests/integration/bot-screen-lifecycle.test.ts` — 14 pass, 0 fail, 159 expect() calls; 14 tests across 2 files in 60.24s.
- `bun run typecheck` — passed (`tsc --noEmit`) in 4.64s.

No formatter, linter, broad test suite, separate project-wide build, or commit was run.

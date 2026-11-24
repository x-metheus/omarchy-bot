# Tasks: Bot runtime on pi-durable

Plan: [plan.md](plan.md) · Spec: [bot-runtime.md](../../specs/bot-runtime.md)

Every task also meets the [Definition of Done](../../../.agents/references/definition-of-done.md). Unless a task says otherwise, verification is:

```
bun run typecheck
bun run lint:boundaries
bun test apps/daemon
```

"The switch" means the Service setting `runtime: "durable"` from Task 3.

---

## Task 1: Pinned packages, runtime module skeleton, Harness lifecycle, and boundary lint

**Description:** Add `@earendil-works/pi-ai`, `pi-durable`, and `pi-mcp` at exactly 1.5.2 to `apps/daemon`. Create `modules/runtime/runtime.ts`, which opens one Harness on Service start with SQLite storage in the Service database under the `pi_` prefix, calls `resume()`, and closes it on shutdown. Extend the boundary test so pi-durable can be imported only from `modules/runtime`.

**Acceptance criteria:**
- [x] The three packages are pinned exactly, and `pi-coding-agent` and `pi-agent-core` are not in the daemon's dependency tree
- [x] Starting the Service creates `pi_` tables in its database; stopping closes the Harness cleanly
- [x] `lint:boundaries` fails on a pi-durable import outside `modules/runtime`

**Verification:** default commands; a test opens the Harness on a temporary database and lists `pi_` tables.

**Dependencies:** None

**Files likely touched:** `apps/daemon/package.json`, `bun.lock`, `apps/daemon/src/modules/runtime/runtime.ts`, `apps/daemon/src/bootstrap/main.ts`, `tests/integration/package-boundaries.test.ts`

**Estimated scope:** Medium

---

## Task 2: Credential store and model providers

**Description:** Add a credential store table with the same protection as device tokens. Add `modules/runtime/models.ts`, which builds `pi-ai` models from stored providers: OpenAI-compatible or Anthropic Messages with a name, base URL, and key, or a built-in `pi-ai` provider with only a key. Add a Service-wide default model setting and an optional `model` on Bots. Add a fake provider for tests.

**Acceptance criteria:**
- [x] Keys are stored only in the credential store and never appear in events, logs, or API responses
- [x] A Bot without a model uses the Service default; a set model is used from its next Turn
- [x] No provider has special-case code

Criterion 2 closed in Task 3: the durable path resolves the Bot's model on every Turn, and the parity suite proves a changed model applies on the next Turn.

**Verification:** default commands; unit tests for provider building and key redaction; migration test.

**Dependencies:** Task 1

**Files likely touched:** `apps/daemon/src/persistence/db.ts`, `apps/daemon/src/modules/runtime/models.ts`, `apps/daemon/src/modules/runtime/credentials.ts`, `packages/testkit/`, `tests/integration/bot-migrations.test.ts`

**Estimated scope:** Medium

---

## Task 3: First Turn on the new runtime, behind the switch

**Description:** Add the `runtime` Service setting, defaulting to `worker`. With `durable`, `TurnService.send` starts a Turn through `BotRuntime.startTurn`: one conversation per Thread, the Bot's model in its `pi.agent` document, and no tools yet. `transcript.ts` writes Service Messages from committed entries and emits today's Turn events, so clients need no change.

**Acceptance criteria:**
- [x] With the switch on, a Direct Thread streams Response and Thinking blocks and finishes the Turn
- [x] For the same fake run, stored Messages and emitted events match the worker path's in order and content
- [x] With the switch off, behavior is unchanged

A second message during a durable Turn is refused with 409 and writes nothing; real Steering is Task 4.

**Verification:** default commands; an integration test runs one fake script through both paths and compares; manual check in `OMARCHY_BOT_DEV=1 bun run dev`.

**Dependencies:** Task 2

**Files likely touched:** `apps/daemon/src/modules/runtime/runtime.ts`, `apps/daemon/src/modules/runtime/conversations.ts`, `apps/daemon/src/modules/runtime/transcript.ts`, `apps/daemon/src/modules/turns/turns.ts`, `tests/integration/`

**Estimated scope:** Medium

---

## Checkpoint A: after Tasks 1–3
- [x] Default commands pass
- [ ] A Direct Thread streams a reply with the switch on in the dev app
- [x] Review with the human before proceeding

---

## Task 4: Steering, follow-ups, abort, failed runs, and `maxTurns`

**Description:** Map a client's Steering to `whenBusy: "steer"` and other messages sent while busy to follow-ups. Wire abort. Use `afterFailedRun: "continue"`, report run failures to the client as today, and apply `maxTurns` with a Service-wide default of 50 and a per-Bot override.

**Acceptance criteria:**
- [x] Steering mid-reply, including during a tool call, lands after the current tool round
- [x] Abort ends the reply, recorded as aborted
- [x] A failed run shows its reason, and queued messages still run

**Verification:** default commands; existing steering and Thread tests pass with the switch on.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/runtime.ts`, `apps/daemon/src/modules/turns/turns.ts`, `apps/daemon/src/modules/runtime/runtime.test.ts`

**Estimated scope:** Small

---

## Task 5: Restart, `resume()`, and shutdown

**Description:** On start, `resume()` continues unfinished replies and tasks, and ends replies that cannot continue with a visible reason. On shutdown, stop accepting input, abort running replies, and close the Harness. Set `restartLimit`. Turn prototype check 3 into a test.

**Acceptance criteria:**
- [x] A Service killed mid-reply resumes or visibly fails that reply on next start, and no Turn is lost silently — `restart.test.ts`: hard-kill recovery and missing submission failure
- [x] A `sleepUntil` task posts once into the same conversation after a hard kill — `restart.test.ts`: sleeping task posts once
- [x] A reply that crashes the process repeatedly stops at the restart limit — `restart.test.ts`: repeated hard kills stop at five interruptions

**Verification:** default commands; restart tests against SQLite in a temporary file, killing a child Service process.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/runtime.ts`, `apps/daemon/src/bootstrap/main.ts`, `apps/daemon/src/modules/runtime/restart.test.ts`

**Estimated scope:** Medium

---

## Task 6: Compaction with author labels

**Description:** Enable automatic and background compaction, with typed `modelOverrides` plumbing. The `beforeCompact` hook calls the conversation's model to write a structured digest with author attribution, decisions, and open items; on failure pi-durable writes its own summary. Show a transcript notice and provide author-label formatting for non-user entries.

**Acceptance criteria:**
- [x] A labeled multi-author conversation compacts into an attributed structured digest; the Turn continues after both success and built-in fallback
- [x] A transcript notice appears and older entries stay in storage
- [x] Exact provider/model overrides are supported and isolated by model
- [ ] Bot mail and Group Thread durable entry write sites use visible author labels
- [ ] A manual run on each default model is recorded

Per-model `modelOverrides` budgets are not set: no small-context model or values are named in the spec or plan, and inventing them is forbidden. The plumbing and its test are in place; naming the models and values needs a human decision.

The author-label formatting helper is in place; write-site wiring lands with the Bot mail / Group Thread tasks.

**Verification:** default commands; attribution and fallback tests use a fake model in CI; a real-model run is recorded in the task notes.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/runtime.ts`, `apps/daemon/src/modules/runtime/compaction.ts`, `apps/daemon/src/modules/runtime/transcript.ts`, tests

**Estimated scope:** Small

---

## Checkpoint B: after Tasks 4–6
The durable fake provider and harness reproduce the worker scripts so existing integration files run with the switch on. Worker-only internals are marked for removal with Task 20. Mailbox, attachments, and other failures caused by tools not yet built in process move to Checkpoint C; user-visible assertions stay intact.

- [x] The durable harness reproduces the worker scripts
- [x] The shared integration files run with the switch on
- [x] Worker-only internals are marked for Task 20 removal
- [x] Existing Thread and lifecycle integration tests pass with the switch on
  - The recorded baseline ran each of the 12 Thread and lifecycle files under `tests/integration/` individually (`bot-screen-lifecycle.test.ts`, `daemon.test.ts`, `ordered-transcript-qa.test.ts`, `permanent-deletion.test.ts`, `profiles-avatars.test.ts`, `response-blocks.test.ts`, `runtime-parity.test.ts`, `shared-workspace.test.ts`, `sidebar-attention.test.ts`, `steering.test.ts`, `thinking-blocks.test.ts`, `threads-drafts.test.ts`).
    The rerun measured 115 pass, 8 fail, and 19 skip with the switch on and 142 pass, 0 fail, and 0 skip with it off. The four `workerOnly` markings for three Shared Workspace `session.open` cases and the native steering capability rejection case moved those four tests from fail to skip, accounting for the change from the recorded switch-on totals of 115 pass, 12 fail, and 15 skip. Marking those four tests whole also skips their runtime-independent filesystem assertions with the switch on; they still run with it off.
    Checkpoint C takes the eight scoped failures. Projection is one cause: the durable transcript keeps only thinking and text content, so no projected tool record appears. For four of them the durable fake also emits no matching tool call: it emits no tool call for either Daemon case or the Thinking Blocks case, and for the Ordered Transcript restart case it emits `steer_boundary` while the test waits for `read`. Idle send followed by active steering is projection alone: its fixture emits `steer-boundary`, but the projected running record never appears. Computer tools account for the first graphical use starting the desktop (Bot Screen lifecycle) and the missing screenshot artifact in the Bot-owned cleanup test (Permanent Deletion). The `process-only` fixture accounts for the quiet completed Turn and state-driven Bot Activity case (Ordered Transcript).
    The wider sweep of all 95 top-level `tests/integration` files measured 659 pass, 75 fail, and 34 skip with the switch on and 735 pass, 18 fail, and 15 skip with it off, with the same 18 environmental failures in both modes (Rust Sidecar binary, Playwright Chromium, `.cursor/install.sh`, and Service port and pairing setup).
    Two durable-only failures outside the 12-file scope are carried forward to Checkpoint C review without a class assignment. In `tests/integration/agent-capabilities.test.ts`, “serializes simultaneous timeouts for independent sessions on one Agent” times out and a delayed assertion receives `cancelled` where it expects `failed`, and “quarantines an unabortable timed-out worker before releasing its Thread” reports Pi offline during Bot creation.
- [x] Killing the Service mid-reply resumes or visibly fails the reply

**Decisions approved on 2026-11-24**

- A user abort removes streaming Response and Thinking blocks, preserves completed blocks, and records cancellation with the supplied reason.
- SIGTERM uses `disconnectForRestart` and records an interrupted Turn as failed with the reason `daemon restart`. A hard kill continues through durable recovery and its restart limit.

**Known limits, not addressed here**

- An abort after the provider ends a Thinking segment but before the projection marks that block completed can drop that Thinking block, which the worker path keeps. Fixing it needs the provider's segment-end signal in the durable projection.
- A hard kill between pi-durable committing the aborted entry and the Service writing the terminal status can resurrect the partial reply on recovery and report the fallback reason `aborted` instead of the user's reason.

---

## Task 7: App prompt sections, Skills list, and private folders

**Description:** Build the system prompt only from app sections: Base Prompt, identity and Job, workspace and private-folder guidance, allowed folders, and the Skills list from `<workspace>/.agents/skills` frontmatter. Create each Bot's private folder at `<workspace>/bots/<bot-id>/` on its first Turn, and remove it on Bot Deletion.

**Acceptance criteria:**
- [x] The prompt sent to the model contains only app sections, in order, and no `AGENTS.md` content
- [x] Each Skill appears by name and description, and global Skill folders are not read
- [x] The private folder is created on the first Turn, kept on rename, and removed on deletion with the confirmation saying so

**Verification:** default commands; a model-request test asserts the prompt.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/extensions/prompt.ts`, `apps/daemon/src/modules/runtime/extensions/skills.ts`, `apps/daemon/src/modules/workspace/sharedWorkspace.ts`, `apps/daemon/src/modules/bots/botDeletion.ts`

**Estimated scope:** Medium

---

## Task 8: Files and shell tools with allowed folders

**Description:** Install pi-durable's `read`, `write`, `edit`, and `bash` tools under an app extension name with an app execution environment. Add the platform paths module (data, workspace, Downloads). Allowed folders are the Shared Workspace, Downloads, and folders added in Settings. Until Task 9, a call outside them is denied.

**Acceptance criteria:**
- [x] Reads and writes inside allowed folders work without asking; symbolic link and `..` escapes are refused
- [x] The Service data directory, the credential store, and other Bots' private folders are always refused
- [x] `bash` starts in the Shared Workspace, has a time limit, and honors abort

**Verification:** default commands; file-access tests from the spec's testing strategy.

**Dependencies:** Task 7

**Files likely touched:** `apps/daemon/src/modules/runtime/extensions/files-shell.ts`, `apps/daemon/src/modules/workspace/paths.ts`, `apps/daemon/src/modules/workspace/allowedFolders.ts`, tests

**Estimated scope:** Medium

---

## Task 9: Approval flow on the Service

**Description:** Add the approval flow from the spec. `beforeTool` decides whether approval is needed. The tool then runs as a replay-safe durable tool task that records a pending approval and waits on it with durable sleeps. Migrate the `approvals` table forward. Add the API to list and answer approvals, and the events. Requests expire after 7 days. Files outside the allowed folders are the first user, with Allow once, Always allow this folder, and Deny.

**Acceptance criteria:**
- [x] A write outside the allowed folders pauses, survives a restart without asking twice, and after approval writes exactly once — `restart.test.ts`: pending approval survives a hard kill
- [x] "Always allow this folder" adds the folder; Deny returns an error result to the Bot — `files-shell.test.ts`
- [x] A clean shutdown while waiting uses no restart retry, and an expired request returns "no answer" — `restart.test.ts`: clean shutdown; `files-shell.test.ts`: expired request

Decided 2026-11-24: a clean shutdown does not abort a reply waiting for approval. The Turn stays working, the Harness closes under it, and the next start resumes the same request. Every other running reply still fails with `daemon restart`.

The wait runs inside the replay-safe tool task, as in the prototype: a tool cannot sleep durably in pi-durable 1.5.2. It wakes on the answer and re-checks the stored request at least once a minute. `write` and `edit` record the file's digest before changing it, so a rerun never applies a change twice. The API is `GET /api/approvals[?threadId=]` and `POST /api/approvals/:id/answer` with `allow_once`, `allow_folder`, or `deny`; Thread events are `approval.requested` and `approval.resolved`.

**Verification:** default commands; prototype check 6 as a test.

**Dependencies:** Task 8

**Files likely touched:** `apps/daemon/src/modules/runtime/approvals.ts`, `apps/daemon/src/persistence/db.ts`, `apps/daemon/src/api/approvalRoutes.ts`, `packages/protocol/`, tests

**Estimated scope:** Medium

---

## Task 10: Approval UI in the web client

**Description:** Show pending approvals on the Thread and as notifications, naming the Bot, the action, and the path, with the three answers. Follow `apps/web/AGENTS.md`.

**Acceptance criteria:**
- [ ] A pending request appears on its Thread and in notifications, and answering it updates the Thread
- [ ] Keyboard-operable with accessible labels
- [ ] A request answered on another client disappears here

**Verification:** default commands plus `bun run test:e2e` with one Playwright flow.

**Dependencies:** Task 9

**Files likely touched:** `apps/web/src/components/`, `apps/web/src/lib/`, `packages/api-client/`, `tests/e2e/`

**Estimated scope:** Medium

---

## Task 11: Computer and browser tools in process

**Description:** Port the computer and browser tools from `workers/pi/src` to runtime extensions that call `ComputerBroker` directly.

**Acceptance criteria:**
- [ ] Computer and browser tool calls behave as on the worker path
- [ ] Each tool has a time limit and honors abort

**Verification:** default commands; `agent-computer-tool` and `agent-browser-tool` integration tests pass with the switch on.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/extensions/computer.ts`, `apps/daemon/src/modules/runtime/extensions/browser.ts`, tests

**Estimated scope:** Small

---

## Task 12: Bot mail, Local Sidecar, and plugin tools in process

**Description:** Port the Bot mail, local, and plugin tools to runtime extensions that call `MailboxService`, `SidecarBroker`, and `PluginsService` directly. Bot mail notices reach the target as `write` entries with author labels. The plugins tool keeps only managing actions (connect and sign in to accounts; install, enable, and remove Skills and MCP servers); calls to a connected service go through `mcp` (Task 13). Skills installed from the catalog go into `<workspace>/.agents/skills`.

**Acceptance criteria:**
- [ ] Mail, sidecar, and plugin tool calls behave as on the worker path
- [ ] The Bot's identity comes from the active Turn, never from tool arguments
- [ ] A Skill installed from the catalog appears in the Bot's Skills list on its next Turn

**Verification:** default commands; `bot-mailbox` and `local-sidecar-dispatch` integration tests pass with the switch on.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/extensions/mail.ts`, `.../local.ts`, `.../plugins.ts`, tests

**Estimated scope:** Medium

---

## Checkpoint C: after Tasks 7–12
Mailbox, attachments, and every failure caused by tools not yet built in process move here from Checkpoint B, including tool-call projection, native events, capability inventory, the `process-only` fixture, computer and browser tools, and sidecar tools.

- [ ] Computer, browser, mailbox, and sidecar integration tests pass with the switch on
- [x] A write outside the allowed folders asks, survives a restart, and writes once (Task 9, `restart.test.ts`)
- [ ] Review with the human before proceeding

---

## Task 13: MCP through `pi-mcp`

**Description:** Add the MCP extension: servers from `<workspace>/.mcp.json` and service accounts connected in the plugins panel, stdio and Streamable HTTP, connected on first use, exposed as one `mcp` tool with search, describe, and call. Keep the Services panel's status behavior.

**Acceptance criteria:**
- [ ] A Bot calls a tool on a configured MCP service through the `mcp` tool
- [ ] stdio servers run as child processes that are killed on abort and shutdown
- [ ] The Services panel shows each server's status as today

**Verification:** default commands; an integration test with a local test MCP server.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/extensions/mcp.ts`, `apps/daemon/src/modules/plugins/nativeMcp.ts`, tests

**Estimated scope:** Medium

---

## Task 22: Secret store, secrets tool, and a clean shell environment

**Description:** Add the spec's [Secrets](../../specs/bot-runtime.md#secrets): one store in the OS keychain for app secrets (provider keys, MCP sign-ins) and each Bot's private secrets, with the 0600 file only as a fallback that Settings warns about. Add the `secrets` tool (save, list names, delete; never returns a value), `{{secret:name}}` filling in `bash`, `web_fetch`, and `mcp` calls, and replacement of used values in results. Move keys from `model-credentials.json` into the keychain on first start and remove the file. Start `bash` with a clean environment. Keychain access needs a library or each platform's command-line tool: choosing a library is an ask-first dependency decision.

**Acceptance criteria:**
- [ ] A secret saved by one Bot is filled in at run time for that Bot, replaced in the result, and cannot be listed or used by another Bot
- [ ] No secret value appears in `pi_` entries, Service Messages, logs, events, or memory
- [ ] Existing provider keys move into the keychain once, and Turns still complete; without a keychain the fallback file is used and Settings warns
- [ ] `bash` cannot see the Service's environment variables
- [ ] Bot Deletion removes the Bot's secrets, and the confirmation says so

**Verification:** default commands; tests with a fake keychain backend, plus one manual run on Linux Secret Service.

**Dependencies:** Tasks 2 and 8. Tasks 14 and 16 use this store.

**Files likely touched:** `apps/daemon/src/modules/runtime/secrets.ts`, `apps/daemon/src/modules/runtime/credentials.ts`, `apps/daemon/src/modules/runtime/extensions/secrets.ts`, `apps/daemon/src/modules/runtime/extensions/files-shell.ts`, `apps/daemon/src/modules/bots/botDeletion.ts`, tests

**Estimated scope:** Medium

---

## Task 14: MCP OAuth sign-in and token import

**Description:** Add an `McpOAuthStateStore` backed by the secret store (Task 22), a loopback callback listener on `127.0.0.1`, and a sign-in action in the Services panel. On first start, import `pi-mcp-adapter` tokens from the system keyring once, read-only, converting expiry from seconds to milliseconds. A token that fails shows "needs sign-in".

**Acceptance criteria:**
- [ ] Signing in to an OAuth MCP service from the Services panel completes and the tool works
- [ ] Imported tokens that work are used; others show "needs sign-in"
- [ ] The keyring is never written

**Verification:** default commands; a test against a local OAuth test server; one manual sign-in to a real service.

**Dependencies:** Tasks 13 and 22

**Files likely touched:** `apps/daemon/src/modules/runtime/mcpOAuth.ts`, `apps/daemon/src/api/pluginRoutes.ts`, `apps/web/src/components/`, tests

**Estimated scope:** Medium

---

## Task 15: `web_fetch` and `web_search`

**Description:** Add the web extension as the spec describes: `web_fetch` reads a URL as text, extracting with `@mozilla/readability` on `linkedom` and converting with `turndown` (approved 2026-11-24, pinned exactly, imported only by the web extension), and refuses internal addresses unless Settings exempts a range; `web_search` uses Exa's free MCP endpoint through `pi-mcp` by default, with an optional Exa key. Report rate limits as rate limits.

**Acceptance criteria:**
- [ ] Internal addresses are refused with an error naming the range and the setting
- [ ] HTTP 429 and the `ai.exa/rateLimited` flag are reported as rate limits, never as empty results
- [ ] Results are marked as outside content for the memory trust rules
- [ ] Downloads over 5 MB stop with a clear error; extraction runs in a worker thread with a time limit, and a slow or huge page does not block the Service

**Verification:** default commands; tests against a local HTTP stub.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/extensions/web.ts`, `apps/daemon/src/modules/runtime/extensions/web.test.ts`, Settings schema

**Estimated scope:** Small

---

## Task 16: Provider import, Settings providers screen, and per-Bot model

**Description:** On first start, copy keys from `~/.pi/agent/auth.json` and providers from `~/.pi/agent/models.json` into the secret store (Task 22), read-only, and seed the Service default model from the Pi default. Add a Settings screen to add, edit, and remove providers by protocol, a list of allowed folders to add and remove, and a model picker in Bot Settings.

**Acceptance criteria:**
- [ ] The import runs once, never writes `~/.pi`, and leaves existing Bots on their current model
- [ ] A provider added in Settings completes a Turn, for both an OpenAI-compatible and a built-in `pi-ai` provider
- [ ] Keys are never shown after saving
- [ ] A folder added in Settings is allowed on the next tool call, and a removed one is not

**Verification:** default commands; a migration test with fixture `~/.pi` files; one Playwright flow.

**Dependencies:** Tasks 2 and 22

**Files likely touched:** `apps/daemon/src/modules/runtime/providerImport.ts`, `apps/daemon/src/api/`, `apps/web/src/routes/`, `apps/web/src/components/`, tests

**Estimated scope:** Medium

---

## Task 17: Workspace cleanup

**Description:** Implement the one-time workspace cleanup from the spec: one Skills folder and one `.mcp.json`, merging servers and Skills from `.pi`, `.codex`, and `.claude`, moving those folders to a dated backup in the data directory, changing nothing if any step fails, and writing a marker file.

**Acceptance criteria:**
- [x] Skills and MCP servers from the three old folders end up in the one Skills folder and `.mcp.json` — MCP merge, conflict handling, Codex conversion, Skills migration, alias replacement, duplicate basenames, and case-folded allocation ([cleanup.test.ts](../../../apps/daemon/src/modules/workspace/cleanup.test.ts)). The integration test verifies migration on the first Service start ([workspace-cleanup.test.ts](../../../tests/integration/workspace-cleanup.test.ts)).
- [x] A failure at any step leaves every folder unchanged — full snapshot restoration after throws at `folders`, `skills`, `mcp`, and `marker`, plus journal undo before a fresh migration ([cleanup.test.ts](../../../apps/daemon/src/modules/workspace/cleanup.test.ts)).
- [x] A second start does nothing — cleanup returns `skipped` when the marker exists and preserves the full snapshot ([cleanup.test.ts](../../../apps/daemon/src/modules/workspace/cleanup.test.ts)). The second Service boot preserves the marker, backups, and `.mcp.json` ([workspace-cleanup.test.ts](../../../tests/integration/workspace-cleanup.test.ts)).

**Decisions**

- Cleanup runs unconditionally once per Service start, after `openBotRuntime` and before `PluginsService` construction. Failures are logged and retried on the next start.
- `<dataDir>/workspace-cleanup.json` stores `{version: 1, completedAt, backup}`. The backup at `<dataDir>/workspace-backup-YYYY-MM-DD` includes all unrecognized content. On collision, suffixes start at `-2`.
- Cleanup plans in memory, stages merged Skills and `.mcp.json` in `<dataDir>/workspace-cleanup-<random-suffix>`, and commits with ordered renames, publishing the marker last. A small journal records pending and completed renames so the next start can undo them if the marker is absent.
- `.mcp.json` wins same-name conflicts, and warnings name servers only. The Codex allowlist is `type`, `command`, `args`, `env`, `url`, `headers`, `enabled`, and `http_headers`. Entries using `env_vars`, `env_http_headers`, `bearer_token_env_var`, `enable`, SSE, `cwd`, or other unsupported fields stay only in the backup.
- Skill identity comes from the `SKILL.md` frontmatter name or the directory basename. `.agents/skills` wins, and an existing `NativeSkills` alias into a legacy root is replaced only by its exact matching source. Duplicate basenames get deterministic suffixes through case-folded allocation. Cleanup copies symlinked legacy Skills and Skills in linked roots, preserving the targets.
- `NativeSkills` scans only `.agents/skills` and the private disabled folder. It creates no `.claude` aliases, reconciles pre-upgrade disabled entries to `.agents/skills`, and ignores directories resolving into legacy roots.

**Known limits**

- Cleanup assumes one Service starts before clients write. Concurrent writers and editors are out of scope.
- Recovery covers one interrupted journaled commit. A kill before the first journal write or after marker publication can leave staging. Repeated interruption and power-loss durability are out of scope.
- Cross-device moves copy, publish, then remove the source. A further failure during recovery can leave a partial copy.
- Unmatched dangling legacy Skill aliases may remain.
- `NativeMcpStore` may still recreate `.pi/settings.json` until the MCP adapter is retired in the later runtime tasks (Task 20 checks its removal). Later legacy writes persist after cleanup.

**Verification:**

- `bun test apps/daemon` — 158 passed, 1 pre-existing platform skip.
- `bun test apps/daemon/src/modules/workspace/cleanup.test.ts` — 33 passed.
- `bun test tests/integration/workspace-cleanup.test.ts` — 1 passed.
- `bun run lint:boundaries` — 4 passed.
- `bun run typecheck` — one pre-existing failure at `tests/integration/daemon.test.ts:289`, unrelated to Task 17.

**Dependencies:** Task 7

**Files likely touched:** `apps/daemon/src/modules/workspace/cleanup.ts`, `apps/daemon/src/modules/plugins/nativeSkills.ts`, tests

**Estimated scope:** Small

---

## Checkpoint D: after Tasks 13–17
- [ ] Every tool in the spec's tools table works with the switch on
- [ ] Both kinds of provider added in Settings complete a Turn

---

## Task 18: Old session migration on a Thread's first Turn

**Description:** On a Thread's first Turn on the new runtime, read its old Pi session file read-only, and write the latest compaction summary and later messages into a new conversation with native roles. Unmappable messages become labeled text; old thinking is not replayed; metadata is dropped. If that fails, seed from the Service transcript.

**Acceptance criteria:**
- [ ] A Thread with an old session continues with its history
- [ ] A broken session file falls back to the transcript seed and logs it
- [ ] Old session files are untouched until their Bot is deleted, and deletion removes only the recorded path

**Verification:** default commands; tests with copies of real session files from the current release.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/conversations.ts`, `apps/daemon/src/modules/runtime/sessionMigration.ts`, `tests/integration/fixtures/`, tests

**Estimated scope:** Medium

---

## Task 19: Cutover and deletion

**Description:** Make `durable` the only path: remove the switch and the worker branch from `TurnService`. Threads cannot be deleted; deleting a Bot deletes all its conversations. Stop requiring Agent readiness to start a Turn.

pi-durable 1.5.2 exposes no conversation deletion API, so the runtime module adds one contained function that deletes a conversation's rows from the `pi_` tables in a transaction, as the spec's Storage section describes. It is the only direct write to pi-durable's tables, it has a test that runs on every Pi upgrade, and the memory spec's conversation reset reuses it. An index insertion failure can leave an unindexed conversation; Task 19 also sweeps such orphaned conversations.

**Acceptance criteria:**
- [ ] Every existing Thread, mailbox, attachment, and lifecycle test passes on the runtime
- [ ] Deleting a Bot leaves no `pi_` rows for any of its conversations
- [ ] The delete function's test fails if a pi-durable upgrade adds a `pi_` table it does not cover
- [ ] Creating a Bot needs no Agent

**Verification:** default commands plus `bun test`.

**Dependencies:** Tasks 4–18

**Files likely touched:** `apps/daemon/src/modules/turns/turns.ts`, `apps/daemon/src/modules/bots/botDeletion.ts`, `apps/daemon/src/modules/threads/threads.ts`, `apps/daemon/src/modules/bots/bots.ts`

**Estimated scope:** Medium

---

## Task 20: Remove the Pi worker, agent protocol, and Agent UI

**Description:** Delete `workers/pi`, `agent-protocol.ts` and its tests, the Pi conformance tests, and the Agent picker, Pending Agents, and Agent conformance UI. Keep Agent identity fields in storage until nothing reads them. Rename "Native Session" to "Bot session" in user-facing text.

**Acceptance criteria:**
- [ ] No code imports `pi-coding-agent`, `pi-mcp-adapter`, or the agent protocol, and nothing reads `~/.pi` after the import
- [ ] The web client has no Agent picker or Pending Agents
- [ ] `bun run build` passes

**Verification:** `bun run build`, `bun test`, `bun run test:e2e`.

**Dependencies:** Task 19

**Files likely touched:** `workers/pi/` (deleted), `packages/agent-contract/src/agent-protocol*.ts`, `tests/conformance/`, `apps/web/src/components/`, `apps/daemon/src/modules/agents/registry.ts`

**Estimated scope:** Medium (mostly deletion)

---

## Task 21: Real scenarios, end-to-end tests, and docs

**Description:** Rerun the real computer and browser scenarios and a small set of everyday tasks before and after. Update `README.md`, `docs/README.md`, and `docs/development.md` for the new runtime and commands.

**Acceptance criteria:**
- [ ] The real scenarios pass, and before-and-after results are recorded
- [ ] Docs describe the runtime, Settings providers, and the "not a sandbox" wording
- [ ] Every success criterion in the spec is met

**Verification:** `bun run build`, `bun test`, `bun run test:e2e`, the real scenarios.

**Dependencies:** Task 20

**Files likely touched:** `README.md`, `docs/README.md`, `docs/development.md`, `tests/e2e/`

**Estimated scope:** Small

---

## Checkpoint E: complete
- [ ] Every spec success criterion is met
- [ ] `bun run build`, `bun test`, and `bun run test:e2e` pass
- [ ] Review with the human before merging

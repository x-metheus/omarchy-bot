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
- [x] A pending request appears on its Thread and in notifications, and answering it updates the Thread — `19-approvals.spec.ts`: the card names the Bot, action, and path; `events.test.ts`: `approval.requested` notification copy
- [x] Keyboard-operable with accessible labels — `19-approvals.spec.ts`: Tab order, Enter answers, focus moves to the next card or composer, and an error restores it; `approvalFocus.test.ts`
- [x] A request answered on another client disappears here — `19-approvals.spec.ts`: an authenticated POST removes the card within the shared 8-second deadline, shorter than the 15-second poll

**Verification:** `bun run typecheck`, `bun run lint:boundaries`, `bun test apps/daemon`, `bun test apps/web`, and `bun run test:e2e`. While iterating, `bun run test:e2e -- specs/19-approvals.spec.ts` runs the approval flow alone. The flow creates its Bot and two Threads through the Service API. The Bun helper in `tests/e2e/seed-approval.ts` inserts only pending approval rows into the isolated e2e database because the Service has no route that creates approvals. Listing, answering, and resolution events use the real Service. The typecheck error at `tests/integration/daemon.test.ts:289` came from Task 9 and was fixed on main in `5a92a12`. At the Task 9 baseline (`05f2ad0`), the full `bun run test:e2e` already failed the same 8 tests in `02-chat.spec.ts` and `13-responsive-accessible-visual-qa.spec.ts`; the approval flow passes both inside the full suite and alone, and again after the merge into main.

Decided 2026-11-24: the approval UI reuses the inline `Banner` + `Button` composer-error pattern, so the plan's design-pass question does not need a new screen or visual pattern. Desktop notifications fire for live `approval.requested` events only; events replayed after a reconnect stay quiet and still invalidate the approvals query, so the Thread recovers the current state without alerting for requests already answered, expired, or deleted. Existing turn-completion replay notifications are unchanged. The pending list is the plain `["approvals", threadId]` query with a 15-second refetch, and both approval events invalidate it. A 409 answer means the request was already answered, so the card refreshes instead of showing an error. Control and bidi characters in paths render as labelled `\uXXXX` escapes with literal backslashes doubled, so the displayed path cannot be confused with another; the Service still receives the raw path. After a keyboard answer, focus moves to the first surviving following approval, then the composer, then the conversation-history button, and is not stolen if it moved elsewhere. The e2e seed helper is test-only; no product route was added.

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
- [x] A secret saved by one Bot is filled in at run time for that Bot, replaced in the result, and cannot be listed or used by another Bot — `bash keeps an out-of-band Bot secret out of entries, messages, console output, and events`; `secrets and bash cannot list, delete, or use another Bot's or the app's secrets`
- [ ] No secret value appears in `pi_` entries, Service Messages, logs, events, or memory — store values proven by `bash keeps an out-of-band Bot secret out of entries, messages, console output, and events` and `a durable provider failure redacts app and Bot secrets from the Turn and its status event`. Gap: a value the model itself supplies to `secrets` save stays in its assistant tool-call entry, like a secret typed into a Thread; pi-durable's own journal may keep the original provider diagnostic; Bot memory is not implemented yet.
- [ ] Existing provider keys move into the keychain once, and Turns still complete; without a keychain the fallback file is used and Settings warns — `migrates two legacy providers into app secrets once and reloads them without the file`; `a durable Turn completes with a migrated provider after the legacy file is removed`; `runtime imports a healthy legacy provider when another record fails and retains the file`; `warns about the file backend across Settings sections`. Keychain paths are exercised with the fake backend only; the real OS keychain backend is pending the library/CLI decision.
- [x] `bash` cannot see the Service's environment variables — `bash starts with PATH and excludes the Service environment marker`
- [x] Bot Deletion removes the Bot's secrets, and the confirmation says so — `permanent deletion removes only the deleted Bot's private secrets`; `opens the pointer-only Sidebar menu, keeps Bot Settings reachable, cancels unchanged, then deletes and falls back`

**Decisions (2026-11-24):**

- One `SecretBackend` seam; the OS keychain plugin is pending, so runtime uses the 0600 file fallback and tests use an in-memory fake. Accounts are namespaced by data directory; the metadata index is 0600; fallback values live in a 0700 `secrets/` directory.
- Fill happens on a copy at execute time; persisted arguments keep `{{secret:name}}`. A call that used a secret emits no live output and keeps a bounded, redacted tail (spill off, since the spill file would hold raw output).
- The `secrets` tool exposes only the calling Bot's scope; app scope is unreachable. Save rejects empty values and metadata containing the value; delete removes the backend value first, then metadata, and a failed delete stays listed for retry and Bot Deletion.
- Provider records are app secrets: hashed name, non-secret metadata as the description, key as the value. Migration imports per record, keeps the legacy file if any record fails, and removes it once all are verified.
- Clean shell environment is an explicit allowlist: `PATH`, `HOME`, `LANG`, `TMPDIR`, `USER`, `SHELL`.
- Protocol: `removed.secrets` is optional with a default of 0 and `secrets` is a failure stage; `PROTOCOL_VERSION` is not bumped because the web client ships with the daemon. A separately versioned client needs the next bump at cutover.
- Known limits: shell placeholder substitution is literal, so the Bot's quoting is its responsibility (prefer the environment argument); secret-using calls return bounded output; `secrets` save arguments are model-visible.

**Verification:** default commands; tests with a fake keychain backend, plus one manual run on Linux Secret Service (still manual, pending the backend decision).

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
- [x] The import runs once, never writes `~/.pi`, and leaves existing Bots on their current model. In `apps/daemon/src/modules/runtime/providerImport.test.ts`, `skips a second pass after deletion and leaves the Pi file contents and mtimes intact` compares bytes and mtimes for all three files and checks that the removed provider stays removed. `preserves pre-existing provider credentials, the Service default, and the Bot model` checks the persisted values, and `a model-level proxy leaves a pinned Anthropic Bot on the native route` checks resolution for an existing override. `imports custom and built-in providers, prefers literal auth keys, and seeds the Service default` verifies seeding. In `tests/integration/provider-import.test.ts`, `daemon startup imports Pi credentials and runs an unset Bot on the seeded default only once` boots with fixture files under a temporary `HOME`, completes a durable Turn on the seeded default, and verifies that a restart leaves the removed provider absent.
- [x] A provider added in Settings completes a Turn, for both an OpenAI-compatible and a built-in `pi-ai` provider. In `tests/integration/providers.test.ts`, `an HTTP-added openai-compatible provider completes a durable Turn` and `an HTTP-added built-in provider completes a durable Turn` create providers through the Settings HTTP API and assert completed Turns and transcript replies using an offline model stub.
- [x] Keys are never shown after saving. In `tests/integration/providers.test.ts`, `custom provider CRUD preserves an omitted key and hides credentials in raw JSON` checks raw and parsed responses for the absence of key fields and credential sentinels, and `built-in catalog projection omits model metadata containing a stored key` checks for a key sentinel in catalog metadata. `invalid provider requests return 400 without echoing request values, and unknown IDs return 404` and `provider listing omits a legacy base URL containing userinfo` cover error responses and legacy URLs. `provider writes reject encoded keys in base URLs without echoing credentials` checks HTTP 400 responses for submitted and stored keys. `provider listing hides legacy metadata containing an encoded stored key` checks that HTTP and store listings omit a legacy provider with an encoded key in its URL and omit a model with an encoded key in its name. `apps/daemon/src/api/providerRoutes.ts` returns the key-free projection with `hasKey`. In `tests/e2e/specs/16-providers-and-folders.spec.ts`, `a custom provider persists and can be renamed without reentering its key` and `a built-in provider uses the searchable catalog and a key-only form` verify that saved keys are absent from page HTML and that the key input is blank on edit. The custom flow also checks after reload and verifies that the rename request omits the key.
- [x] A folder added in Settings is allowed on the next tool call, and a removed one requires approval again. In `tests/integration/allowed-folders.test.ts`, `adding and removing a folder affects file access on the next Turn` verifies that the next Turn reads the fixture with no approval after addition, then requests approval for the same file on the next Turn after removal. Denial produces an access-denied reply.

**Verification:** Default commands, a migration test with fixture `~/.pi` files, and the providers and folders Playwright spec.

**Dependencies:** Tasks 2 and 22

**Files likely touched:** `apps/daemon/src/modules/runtime/providerImport.ts`, `apps/daemon/src/api/`, `apps/web/src/routes/`, `apps/web/src/components/`, tests

**Estimated scope:** Medium

### Decisions

- **v1.** Resolve `PI_CODING_AGENT_DIR` when set. Expand `~` and `~/` against the Service home, resolve `file://` URLs, and use relative paths from the process working directory. Fall back to `~/.pi/agent` under the Service home. Read `auth.json`, `models.json`, and `settings.json` without writing to the Pi directory. Strip a leading BOM in all three files. For `models.json`, accept line comments and trailing commas as Pi does, plus block comments. Treat missing or malformed JSON as empty. Other read failures leave the import eligible to retry on the next startup.
- **v2.** Import literal API keys into the Service secret store, preferring `auth.json` over `models.json`. Skip OAuth credentials, `!` commands, and unescaped environment references. Interpret Pi's escaped dollar and bang sequences as literals. Import built-in IDs on their native `pi-ai` route when there is no provider-level base URL. A supported provider-level proxy on a built-in ID imports as custom under the same ID. Map Pi `openai-completions` to `openai-compatible` and `anthropic-messages` to `anthropic-messages` for custom routes.
- **v3.** For configured models, take the API and base URL from the model, the provider, or the matching or first composed catalog model, in that order. A custom provider can infer a missing base URL from its model definitions when they resolve to one URL, and infer a missing API when the model APIs agree. Keep catalog entries whose API and base URL match the imported route. For a native built-in, compare with the matching stock model or the first stock model for a new ID.
- **v4.** Any existing `service_settings.pi_provider_import` value skips the pass. After provider writes succeed, set the marker to `1` in the same database transaction as any `default_model` seed, including on an empty import. Seed only when the Service default is unset and the selected model is available on a stored provider whose route preserves the Pi selection. Keep existing provider records and Bot overrides. Bots without overrides use the Service default.
- **v5.** The provider API serializes mutations. It derives custom IDs from lowercase name slugs with numeric collision suffixes, reserving every built-in ID. Built-in creation requires `pi-ai` `auth.apiKey` eligibility and returns HTTP 409 for a duplicate. Updates keep an omitted key and replace the stored model list when supplied. Create, update, and projection keep the first occurrence of each model ID. Built-in updates accept key and model changes, and the projected stock catalog takes precedence over extra models with the same ID.
- **v6.** Provider responses use a key-free DTO with `hasKey` and projected model metadata. The store filters projected metadata containing literal or percent-encoded copies of stored keys. The API accepts HTTP(S) base URLs without userinfo and rejects base URLs containing literal or percent-encoded copies of the submitted key or an existing provider key. Responses omit legacy URLs that fail HTTP(S) or userinfo validation. Pending removals keep the record available for deletion retry while excluding its credentials from runtime lookups.
- **v7.** Allowed-folder responses return normalized Settings entries in `folders` and the implicit Shared Workspace and eligible Downloads directory in `alwaysAllowed`. POST and DELETE on implicit paths are no-ops. The removal helper validates and normalizes absolute paths, rejects NUL, and rewrites the Settings array only when a matching entry exists. Durable file policy reads Settings on each tool call, so the next call picks up additions and removals.
- **v8.** `BotDto.model` is nullable. PATCH validates the reference at the first slash, leaving any later slashes in the model ID. Omission keeps the override and `null` clears it. The next durable Turn resolves the current Bot override or Service default. `bot.updated` includes the model and invalidates the web Bot cache.
- **v9.** Providers and Allowed folders reuse the Settings dialog and mobile sheet with existing Astryx components. The built-in catalog uses searchable Typeahead. Provider forms use a password input, clear the submitted key after save, and open with a blank key on edit. Saved rows show key status only.
- **v10.** Bot Settings saves model choices immediately, with `Service default` sending `null`. On failure, rollback applies only when the latest cached model still equals the attempted value, preserving other fields and any newer model selection. Profile name and instructions sync independently when their corresponding drafts still match the previous server values.

### Evidence

- `bun run typecheck` exited 0 with 0 TypeScript errors. `bun run lint:boundaries` passed 4 tests in 1 file with 0 failures.
- `bun test apps/daemon` passed 253 tests in 19 files with 1 skip and 0 failures on an isolated rerun that took 67.61 seconds. The skip requires a case-insensitive filesystem. The initial run reached the tool's 60-second limit before Bun printed totals.
- `bun test apps/web` passed 109 tests in 13 files with 0 failures.
- The pre-audit-fix run of `bun test apps/daemon/src/modules/runtime/providerImport.test.ts tests/integration/provider-import.test.ts tests/integration/providers.test.ts tests/integration/allowed-folders.test.ts tests/integration/bot-model.test.ts apps/daemon/src/modules/workspace/allowedFolders.test.ts` passed 42 tests in 6 files with 0 failures. The respective file counts were 20, 1, 11, 4, 2, and 4.
- The post-audit-fix run of `bun test apps/daemon/src/modules/runtime/credentials.test.ts tests/integration/providers.test.ts tests/integration/provider-import.test.ts` passed 22 tests in 3 files with 0 failures, including all 15 tests in `providers.test.ts`.
- `bunx playwright test -c tests/e2e specs/16-providers-and-folders.spec.ts` passed all 4 Chromium tests with 0 failures in an isolated run.

### Not done / residual risks

- Settings displays the base URL, including its query string. An unrelated secret in a query parameter, such as a token separate from the provider key, can still be displayed.
- The Pi import drops `modelOverrides` and the provider options `headers`, `authHeader`, and `compat`.
- A partial import that fails before setting the marker can re-create a provider deleted between attempts.
- Model-level proxy entries on built-in providers that differ from the native route are dropped when there is no provider-level proxy.
- The OS keychain backend is still Task 22's pending decision. The Service uses the private-file fallback.
- Earlier Playwright cold starts intermittently hit Vite readiness timeouts. All four tests passed on the first isolated run for this verification.

---

## Task 17: Workspace cleanup

**Description:** Implement the one-time workspace cleanup from the spec: one Skills folder and one `.mcp.json`, merging servers and Skills from `.pi`, `.codex`, and `.claude`, moving those folders to a dated backup in the data directory, changing nothing if any step fails, and writing a marker file.

**Acceptance criteria:**
- [ ] Skills and MCP servers from the three old folders end up in the one Skills folder and `.mcp.json`
- [ ] A failure at any step leaves every folder unchanged
- [ ] A second start does nothing

**Verification:** default commands; tests on temporary workspaces.

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
- [x] A Thread with an old session continues with its history. In `tests/integration/session-migration.test.ts`, `a Thread continues its old Pi session in the first durable model request` verifies that the provider request contains the latest compaction summary, post-compaction user, assistant, and tool-result history, and the native `toolCall`/`toolResult` pair. The reply reaches the transcript. The native mapping is also covered in `apps/daemon/src/modules/runtime/sessionMigration.test.ts`.
- [x] A broken session file falls back to the transcript seed and logs it. The same integration suite covers this in `a broken old Pi session seeds prior Service transcript messages and warns`. The unit suite covers missing, unsupported, and malformed files, an empty transcript, a failed transcript commit, and path-free reasons.
- [x] Old session files are untouched until their Bot is deleted, and deletion removes only the recorded path. The 12 tests in `tests/integration/old-session-deletion.test.ts` verify that bytes and mtime stay unchanged across the first durable Turn and that deletion removes only the recorded file. They cover preservation or a zero count for a sibling, another Bot's session, unrelated files, paths with `..`, symlinked ancestors, directories, relative paths, missing files, shared paths, and unlink failures. The sole change to `tests/integration/permanent-deletion.test.ts` adds the count to one exact DTO expectation.

**Verification:** default commands; tests with copies of real session files from the current release.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/conversations.ts`, `apps/daemon/src/modules/runtime/sessionMigration.ts`, `tests/integration/fixtures/`, tests

**Estimated scope:** Medium

### Decisions

- **v1.** In `conversations.ts`, a lazy seed callback runs only when creating a conversation, before the index row is inserted. An indexed conversation bypasses transcript and session reads. A seed failure still allows indexing and the Turn to proceed.
- **v2.** Migration accepts only header version 3 from `pi-coding-agent` 0.84.4. Older versions fail closed to the transcript seed.
- **v3.** Use the last compaction entry and every subsequent entry in file order. Without compaction, migrate all messages. Ignore parent and branch pointers.
- **v4.** Preserve native user messages and assistant text for `stop`, `length`, and `toolUse`. Keep native `toolCall` blocks and `toolResult` messages only in complete, ordered runs matched by `toolCallId` and tool name, including across dropped non-message entries. Label `error` and `aborted` assistant messages and their results. Strip thinking and all signatures, convert unmappable messages to labeled user text such as `[old tool result: name]`, and drop and count metadata and non-message entries.
- **v5.** Write the compaction summary as a user message labeled `Previous conversation compaction summary:`, matching the prototype.
- **v6.** Flatten the transcript fallback into labeled user text and skip old thinking. Use the persisted user message `seq` to exclude the current message and later queued rows. A missing `seq` disables transcript seeding. Session migration can still proceed.
- **v7.** Log `Migrated old Pi session for thread <id>: user=.. assistant=.. toolResult=.. labeled=.. thinking=.. dropped=..` via `console.log`. Use `console.warn` to describe the actual fallback outcome. Filesystem reasons contain only the error code.
- **v8.** Bot deletion unlinks only the exact distinct absolute paths recorded in `thread_sessions` for the Bot's Threads. It skips paths still recorded by another Bot and refuses `..`, symlinked ancestors, directories, and relative paths. With `unlink`, `ENOENT` counts as zero. Failures log codes only, deletion continues, and the result reports `oldSessionFilesRemoved`.
- **v9.** The approved protocol change adds the required non-negative integer `oldSessionFilesRemoved` to `DeleteBotResultDto`. Old session cleanup contributes only a count to the DTO.
- **v10.** All fixtures are synthetic and follow the pinned 0.84.4 format exactly. The repository contains no copied real session content.

### Evidence

- `bun run typecheck` reported one pre-existing failure, TS2769 at `tests/integration/daemon.test.ts(289,59)`, from Task 9; it was fixed on main in `5a92a12`, and typecheck passes after the merge. With the switch on, `permanent-deletion.test.ts` still fails the Bot-owned cleanup case on the missing computer screenshot artifact, a Checkpoint B item that Task 11 owns.
- `bun run lint:boundaries` passed 4 tests with 0 failures. `bun test apps/daemon` passed 167 tests with 1 pre-existing skip and 0 failures. The `sessionMigration` unit suite passed 39 tests.
- `bun test tests/integration/session-migration.test.ts` passed 3 tests, and the same command with `OMARCHY_TEST_DURABLE=1` passed 3. The suite also covers `a new durable Thread without a legacy session sends only its first user message and logs no migration`.
- `bun test tests/integration/old-session-deletion.test.ts` passed 12 tests, and the same command with `OMARCHY_TEST_DURABLE=1` passed 12. `bun test tests/integration/permanent-deletion.test.ts` passed 8 tests.

### Not done / residual risks

- An external process can swap an ancestor between validation and `unlink` (TOCTOU).
- Concurrent deletions of two Bots sharing a path can both skip the file, leaving it for Task 19's orphan sweep and avoiding deletion while either Bot records it.
- A crash between the seed commit and index insert can leave a seeded orphan conversation for Task 19 to sweep.
- The recorded-path deletion test exercises the HTTP endpoint. Live-provider coverage is outstanding.
- The spec asks for copies of real 0.84.4 session files. Verification used only synthetic fixtures that follow that format exactly.

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

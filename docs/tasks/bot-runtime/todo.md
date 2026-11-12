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
- [ ] A Bot without a model uses the Service default; a set model is used from its next Turn
- [x] No provider has special-case code

Criterion 2 is satisfied by the resolver (`resolveModelForBot` re-reads the Bot and the default on every call) and closes in Task 3, when a Turn uses it. No Turn path exists yet, so it is left open rather than ticked early.

**Verification:** default commands; unit tests for provider building and key redaction; migration test.

**Dependencies:** Task 1

**Files likely touched:** `apps/daemon/src/persistence/db.ts`, `apps/daemon/src/modules/runtime/models.ts`, `apps/daemon/src/modules/runtime/credentials.ts`, `packages/testkit/`, `tests/integration/bot-migrations.test.ts`

**Estimated scope:** Medium

---

## Task 3: First Turn on the new runtime, behind the switch

**Description:** Add the `runtime` Service setting, defaulting to `worker`. With `durable`, `TurnService.send` starts a Turn through `BotRuntime.startTurn`: one conversation per Thread, the Bot's model in its `pi.agent` document, and no tools yet. `transcript.ts` writes Service Messages from committed entries and emits today's Turn events, so clients need no change.

**Acceptance criteria:**
- [ ] With the switch on, a Direct Thread streams Response and Thinking blocks and finishes the Turn
- [ ] For the same fake run, stored Messages and emitted events match the worker path's in order and content
- [ ] With the switch off, behavior is unchanged

**Verification:** default commands; an integration test runs one fake script through both paths and compares; manual check in `OMARCHY_BOT_DEV=1 bun run dev`.

**Dependencies:** Task 2

**Files likely touched:** `apps/daemon/src/modules/runtime/runtime.ts`, `apps/daemon/src/modules/runtime/conversations.ts`, `apps/daemon/src/modules/runtime/transcript.ts`, `apps/daemon/src/modules/turns/turns.ts`, `tests/integration/`

**Estimated scope:** Medium

---

## Checkpoint A: after Tasks 1–3
- [ ] Default commands pass
- [ ] A Direct Thread streams a reply with the switch on in the dev app
- [ ] Review with the human before proceeding

---

## Task 4: Steering, follow-ups, abort, failed runs, and `maxTurns`

**Description:** Map a client's Steering to `whenBusy: "steer"` and other messages sent while busy to follow-ups. Wire abort. Use `afterFailedRun: "continue"`, report run failures to the client as today, and apply a per-Bot `maxTurns`.

**Acceptance criteria:**
- [ ] Steering mid-reply, including during a tool call, lands after the current tool round
- [ ] Abort ends the reply, recorded as aborted
- [ ] A failed run shows its reason, and queued messages still run

**Verification:** default commands; existing steering and Thread tests pass with the switch on.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/runtime.ts`, `apps/daemon/src/modules/turns/turns.ts`, `apps/daemon/src/modules/runtime/runtime.test.ts`

**Estimated scope:** Small

---

## Task 5: Restart, `resume()`, and shutdown

**Description:** On start, `resume()` continues unfinished replies and tasks, and ends replies that cannot continue with a visible reason. On shutdown, stop accepting input, abort running replies, and close the Harness. Set `restartLimit`. Turn prototype check 3 into a test.

**Acceptance criteria:**
- [ ] A Service killed mid-reply resumes or visibly fails that reply on next start, and no Turn is lost silently
- [ ] A `sleepUntil` task posts once into the same conversation after a hard kill
- [ ] A reply that crashes the process repeatedly stops at the restart limit

**Verification:** default commands; restart tests against SQLite in a temporary file, killing a child Service process.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/runtime.ts`, `apps/daemon/src/bootstrap/main.ts`, `apps/daemon/src/modules/runtime/restart.test.ts`

**Estimated scope:** Medium

---

## Task 6: Compaction with author labels

**Description:** Turn on automatic and background compaction with `modelOverrides` for small-context models. Show a transcript notice when compaction happens. Put author labels in the visible text of non-user entries, and add the author-preservation compaction instructions.

**Acceptance criteria:**
- [ ] A long conversation compacts and keeps working, and the notice appears
- [ ] Older entries stay in storage
- [ ] A test compacts a labeled multi-author conversation and checks attribution; a manual run on each default model is recorded

**Verification:** default commands; the attribution test with a fake model in CI, and a real-model run recorded in the task notes.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/runtime.ts`, `apps/daemon/src/modules/runtime/compaction.ts`, `apps/daemon/src/modules/runtime/transcript.ts`, tests

**Estimated scope:** Small

---

## Checkpoint B: after Tasks 4–6
- [ ] Existing Thread and lifecycle integration tests pass with the switch on
- [ ] Killing the Service mid-reply resumes or visibly fails the reply

---

## Task 7: App prompt sections, Skills list, and private folders

**Description:** Build the system prompt only from app sections: Base Prompt, identity and Job, workspace and private-folder guidance, allowed folders, and the Skills list from `<workspace>/.agents/skills` frontmatter. Create each Bot's private folder at `<workspace>/bots/<bot-id>/` on its first Turn, and remove it on Bot Deletion.

**Acceptance criteria:**
- [ ] The prompt sent to the model contains only app sections, in order, and no `AGENTS.md` content
- [ ] Each Skill appears by name and description, and global Skill folders are not read
- [ ] The private folder is created on the first Turn, kept on rename, and removed on deletion with the confirmation saying so

**Verification:** default commands; a model-request test asserts the prompt.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/extensions/prompt.ts`, `apps/daemon/src/modules/runtime/extensions/skills.ts`, `apps/daemon/src/modules/workspace/sharedWorkspace.ts`, `apps/daemon/src/modules/bots/botDeletion.ts`

**Estimated scope:** Medium

---

## Task 8: Files and shell tools with allowed folders

**Description:** Install pi-durable's `read`, `write`, `edit`, and `bash` tools under an app extension name with an app execution environment. Add the platform paths module (data, workspace, Downloads). Allowed folders are the Shared Workspace, Downloads, and folders added in Settings. Until Task 9, a call outside them is denied.

**Acceptance criteria:**
- [ ] Reads and writes inside allowed folders work without asking; symbolic link and `..` escapes are refused
- [ ] The Service data directory, the credential store, and other Bots' private folders are always refused
- [ ] `bash` starts in the Shared Workspace, has a time limit, and honors abort

**Verification:** default commands; file-access tests from the spec's testing strategy.

**Dependencies:** Task 7

**Files likely touched:** `apps/daemon/src/modules/runtime/extensions/files-shell.ts`, `apps/daemon/src/modules/workspace/paths.ts`, `apps/daemon/src/modules/workspace/allowedFolders.ts`, tests

**Estimated scope:** Medium

---

## Task 9: Approval flow on the Service

**Description:** Add the approval flow from the spec. `beforeTool` decides whether approval is needed. The tool then runs as a replay-safe durable tool task that records a pending approval and waits on it with durable sleeps. Migrate the `approvals` table forward. Add the API to list and answer approvals, and the events. Requests expire after 7 days. Files outside the allowed folders are the first user, with Allow once, Always allow this folder, and Deny.

**Acceptance criteria:**
- [ ] A write outside the allowed folders pauses, survives a restart without asking twice, and after approval writes exactly once
- [ ] "Always allow this folder" adds the folder; Deny returns an error result to the Bot
- [ ] A clean shutdown while waiting uses no restart retry, and an expired request returns "no answer"

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

**Description:** Port the Bot mail, local, and plugin tools to runtime extensions that call `MailboxService`, `SidecarBroker`, and `PluginsService` directly. Bot mail notices reach the target as `write` entries with author labels.

**Acceptance criteria:**
- [ ] Mail, sidecar, and plugin tool calls behave as on the worker path
- [ ] The Bot's identity comes from the active Turn, never from tool arguments

**Verification:** default commands; `bot-mailbox` and `local-sidecar-dispatch` integration tests pass with the switch on.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/extensions/mail.ts`, `.../local.ts`, `.../plugins.ts`, tests

**Estimated scope:** Medium

---

## Checkpoint C: after Tasks 7–12
- [ ] Computer, browser, mailbox, and sidecar integration tests pass with the switch on
- [ ] A write outside the allowed folders asks, survives a restart, and writes once
- [ ] Review with the human before proceeding

---

## Task 13: MCP through `pi-mcp`

**Description:** Add the MCP extension: servers from `<workspace>/.mcp.json`, stdio and Streamable HTTP, connected on first use, exposed as one `mcp` tool with search, describe, and call. Keep the Services panel's status behavior.

**Acceptance criteria:**
- [ ] A Bot calls a tool on a configured MCP service through the `mcp` tool
- [ ] stdio servers run as child processes that are killed on abort and shutdown
- [ ] The Services panel shows each server's status as today

**Verification:** default commands; an integration test with a local test MCP server.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/extensions/mcp.ts`, `apps/daemon/src/modules/plugins/nativeMcp.ts`, tests

**Estimated scope:** Medium

---

## Task 14: MCP OAuth sign-in and token import

**Description:** Add an `McpOAuthStateStore` backed by the credential store, a loopback callback listener on `127.0.0.1`, and a sign-in action in the Services panel. On first start, import `pi-mcp-adapter` tokens from the system keyring once, read-only, converting expiry from seconds to milliseconds. A token that fails shows "needs sign-in".

**Acceptance criteria:**
- [ ] Signing in to an OAuth MCP service from the Services panel completes and the tool works
- [ ] Imported tokens that work are used; others show "needs sign-in"
- [ ] The keyring is never written

**Verification:** default commands; a test against a local OAuth test server; one manual sign-in to a real service.

**Dependencies:** Task 13

**Files likely touched:** `apps/daemon/src/modules/runtime/mcpOAuth.ts`, `apps/daemon/src/api/pluginRoutes.ts`, `apps/web/src/components/`, tests

**Estimated scope:** Medium

---

## Task 15: `web_fetch` and `web_search`

**Description:** Add the web extension as the spec describes: `web_fetch` reads a URL as text and refuses internal addresses unless Settings exempts a range; `web_search` uses Exa's free MCP endpoint by default, with an optional Exa key. Report rate limits as rate limits.

**Acceptance criteria:**
- [ ] Internal addresses are refused with an error naming the range and the setting
- [ ] HTTP 429 and the `ai.exa/rateLimited` flag are reported as rate limits, never as empty results
- [ ] Results are marked as outside content for the memory trust rules

**Verification:** default commands; tests against a local HTTP stub.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/extensions/web.ts`, `apps/daemon/src/modules/runtime/extensions/web.test.ts`, Settings schema

**Estimated scope:** Small

---

## Task 16: Provider import, Settings providers screen, and per-Bot model

**Description:** On first start, copy keys from `~/.pi/agent/auth.json` and providers from `~/.pi/agent/models.json` into the credential store, read-only, and seed the Service default model from the Pi default. Add a Settings screen to add, edit, and remove providers by protocol, and a model picker in Bot Settings.

**Acceptance criteria:**
- [ ] The import runs once, never writes `~/.pi`, and leaves existing Bots on their current model
- [ ] A provider added in Settings completes a Turn, for both an OpenAI-compatible and a built-in `pi-ai` provider
- [ ] Keys are never shown after saving

**Verification:** default commands; a migration test with fixture `~/.pi` files; one Playwright flow.

**Dependencies:** Task 2

**Files likely touched:** `apps/daemon/src/modules/runtime/providerImport.ts`, `apps/daemon/src/api/`, `apps/web/src/routes/`, `apps/web/src/components/`, tests

**Estimated scope:** Medium

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
- [ ] A Thread with an old session continues with its history
- [ ] A broken session file falls back to the transcript seed and logs it
- [ ] Old session files are untouched until their Thread or Bot is deleted, and deletion removes only the recorded path

**Verification:** default commands; tests with copies of real session files from the current release.

**Dependencies:** Task 3

**Files likely touched:** `apps/daemon/src/modules/runtime/conversations.ts`, `apps/daemon/src/modules/runtime/sessionMigration.ts`, `tests/integration/fixtures/`, tests

**Estimated scope:** Medium

---

## Task 19: Cutover and deletion

**Description:** Make `durable` the only path: remove the switch and the worker branch from `TurnService`. Deleting a Thread deletes its conversation; deleting a Bot deletes all its conversations. Stop requiring Agent readiness to start a Turn.

**Acceptance criteria:**
- [ ] Every existing Thread, mailbox, attachment, and lifecycle test passes on the runtime
- [ ] Deleting a Thread or Bot leaves no `pi_` rows for it
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

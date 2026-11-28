# Spec: Bot runtime on pi-durable

Status: approved 2026-11-10, amended 2026-11-24 and 2026-11-25 (see [Changes](#changes))

Decision record: [ADR 0016](../agents/adr/0016-build-bots-on-pi-durable.md)
Replaces: the earlier draft written for `pi-agent-core` 0.84.4. Its Web and Workspaces rules are copied into this spec, so this spec stands alone.

> The [prototype](#prototype) ran on 2026-11-12 and passed. Its findings are folded into this spec.

## Objective

Bots are personal agents, not coding agents. Today they run on Pi's coding-agent layer (`pi-coding-agent`) in a separate worker process. That layer brings its own coding prompt, tools, resource discovery, and extensions, and it loads whatever Pi packages the user has installed.

This spec replaces that with one runtime the app owns. It is built on `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and `@earendil-works/pi-mcp`, and runs inside the Service. The app decides the prompt, tools, and context on every model call. Nothing depends on the user having Pi, Omarchy, or another agent installed.

This spec covers the runtime: running Turns, storage, tools, models, and file access. It also defines the hook points that two later specs build on:

- **Memory** ([bot-memory.md](bot-memory.md)) uses the per-request and after-run hooks.
- **Proactive Bots** (to be written) use durable tasks, timers, and the approval flow.

### User stories

1. As a user, I want every Bot to behave as a personal assistant, so that coding-agent defaults do not shape it.
2. As a user, I want to create a Bot without choosing an Agent, so that I only decide who the Bot is.
3. As a user, I want my existing Bots, Threads, and transcripts kept, and my Threads to continue, so that I lose no history. Before the app is public, a Thread continues with its transcript kept, but its model context starts fresh on this runtime (see [No migration before public](#no-migration-before-public)).
4. As a user, I want to add model providers in Settings with a URL and key, so that Bots do not depend on another app's login files.
5. As a user, I want to choose which model each Bot uses, so that a Bot no longer depends on a coding agent's settings.
6. As a user, I want computer, browser, Bot mail, Local Sidecar, plugin, web, and MCP tools to keep working, so that Bots lose no abilities.
7. As a user, I want my Skills and connected MCP services to keep working, so that nothing I set up is lost.
8. As a user, I want streaming, Thinking, ordered Tool Calls, and Steering to behave as today, so that conversation quality does not drop.
9. As a user, I want long conversations to keep working, so that a Thread does not run out of context.
10. As a user, I want a reply interrupted by a crash or restart to continue or fail clearly, so that nothing is silently lost.
11. As a user, I want a Bot to save files where I need them, such as my Downloads folder, so that it is useful beyond its workspace.
12. As a user, I want a Bot to ask before touching files outside the folders I allowed, so that a mistake cannot damage my other files.
13. As a user, I want to be told honestly what the workspace protects, so that I do not mistake it for a sandbox.
14. As a user, I want each Bot to have a private folder for notes about itself, while all work files stay shared, so that deleting a Bot loses no work.
15. As a user, I want a Bot to keep passwords and other sensitive data privately and use them without seeing them, so that a Bot misled by a web page cannot reveal them.

### Success criteria

- No Bot Turn imports `pi-coding-agent` or `pi-agent-core`, and none reads `~/.pi`.
- Existing Threads continue on this runtime with their transcripts and each Bot's model. Old model context is not carried over before the app is public.
- A Service killed mid-reply resumes or clearly fails that reply on next start, and no Turn is lost silently.
- No secret value is kept in a plain file where an OS keychain is available, or is sent to a model by the app. The keychain does not stop a Bot's own shell; see the limits under [Secrets](#secrets).
- Every [prototype](#prototype) check and every [test](#testing-strategy) passes.

## Tech stack

- Bun, pinned exactly to 1.4.5 in the repository, CI, and packaging; TypeScript, ES modules, and Bun workspaces. The secret store uses Bun's built-in `Bun.secrets`, which Bun marks experimental, so moving Bun is a deliberate upgrade that reruns the secret-store tests.
- `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and `@earendil-works/pi-mcp`, each pinned to one exact version: the latest release when the prototype starts and when implementation starts. On 2026-11-12 that is 1.5.2 for all three, and `pi-durable` 1.5.2 itself pins `pi-ai` 1.5.2 exactly. The three move together, because they are released together. `pi-durable` is marked experimental, so it is never on a range, and moving to a newer release is a deliberate upgrade that reruns the prototype checks.
- `@earendil-works/chord`, which pi-durable takes on every entry point but does not re-export, is pinned to the same version and imported only by the runtime module.
- `web_fetch` uses `@mozilla/readability`, `linkedom`, and `turndown`, each pinned exactly and imported only by the web extension.
- pi-durable SQLite storage through `node:sqlite`. Bun 1.4.4 runs it end to end (prototype check 1), so no release older than 1.4.4 works.
- Removed: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `pi-mcp-adapter`, and loading of the user's global Pi packages.

## Design

### Composition

The runtime runs **inside the Service process** and has the same lifecycle. It opens when the Service starts and closes when it stops. The separate agent worker (`workers/pi`) and its worker protocol (`packages/agent-contract/src/agent-protocol.ts`) are removed.

The tool protocols to the computer worker and the Local Sidecar stay, because those still run outside the Service. Bot mail and plugins are Service modules, and their tools call them directly.

```
Service process
├─ Bot runtime module            the only code that imports pi-durable
│   ├─ Harness (pi-durable)      one, opened on Service start
│   ├─ Registry                  app extensions: tools, prompt sections, hooks, tasks
│   └─ Models (pi-ai)            providers from the app secret store
├─ Threads, Bots, mailbox, …     existing modules; call the runtime module
└─ Supervisor                    computer worker, sidecars, MCP stdio servers
```

**The runtime module is a boundary.** Other modules use its own small API, not pi-durable types:

- start a Turn
- steer
- abort
- configure a Bot's model
- watch a Thread
- delete a Bot

This keeps an upgrade of the experimental package to one module.

**Bots and Threads map onto pi-durable like this:**

- One pi-durable **conversation** per Thread.
- Each conversation's `pi.agent` document holds that Bot's model, thinking level, extensions, and instructions.
- A [Group Thread](group-threads.md) has one conversation per member Bot, keyed by Thread and Bot.

**Startup:** open the Harness, then call `resume()`. Unfinished replies and tasks continue, and replies that cannot continue end with a visible failure reason.

**Shutdown** stops accepting input, aborts running replies, and closes the Harness. When SIGTERM disconnects the Service for restart, interrupted Turns are recorded as failed with the reason `daemon restart`. A reply waiting for an [approval](#file-access) is not aborted: it stays working, and the next start resumes it with the same request. A user abort records the Turn as cancelled with the supplied reason. Both remove streaming Response and Thinking blocks and preserve completed blocks.

**Crash safety:** commit-before-show and `resume()` cover a crashed Service. pi-durable's retry and `restartLimit` settings stop a reply that keeps crashing the process from looping forever.

**Hangs:** a hang in Service JavaScript would freeze the whole Service, because there is no separate worker any more. Every tool therefore has a time limit and honors abort. Shell, computer, browser, and MCP stdio work runs in child processes, which can always be killed.

### Storage

- **Location:** pi-durable tables live in the Service's SQLite database under the `pi_` prefix, next to the Service's own tables. The prototype confirmed they coexist in a copy of a real database. The Service is their only writer. The Service still owns Bots, Threads, Messages, and attachments in its own tables.
- **Transcript:** the Service's Message records stay the source the clients read today. The runtime module writes them from committed pi-durable entries, so the order and content of blocks match today's ordered transcript (ADR 0007's guarantee).
- **Deletion:** Threads cannot be deleted; Bots can. Bot Deletion deletes all of that Bot's conversations and their entries, which makes it a real deletion, unlike the old Agent-owned sessions. The memory spec's conversation reset after a forget also deletes the old conversation's entries.
- **Deleting conversations:** pi-durable 1.5.2 has no public delete. The runtime module owns one contained function that deletes a conversation's rows from the `pi_` tables in a transaction. It is the only place that writes to pi-durable's tables directly, it has a test that runs on every Pi upgrade, and it is replaced when an upstream request for a public delete lands.
- **No session migration before public release:** a Thread's first Turn on this runtime starts a new, empty conversation. Its Service transcript stays visible to the user, but old Pi session files are not read. Old session files stay until their Bot is deleted, and deletion removes only the exact recorded path.

### No migration before public

The app migrates no data from earlier builds until it is usable and public (decided 2026-11-25). The runtime has no one-time import of old Pi sessions, `~/.pi` providers or keys, `pi-mcp-adapter` tokens, the earlier credential file, or old workspace folders. Schema changes to the Service database still run as forward migrations. Copies that the old worker wrote into the workspace (`.pi/`, `.codex/`, `.claude/`) are not read by the runtime; they are deleted once the worker is removed.

### Turns, Steering, and the input queue

- A user message submits input to the Thread's conversation.
- A message sent while a reply is running uses `whenBusy: "steer"` when the client sends Steering, and the default follow-up otherwise. This matches today's behavior.
- Messages that the Bot should see without replying, such as Bot mail notices and Group Thread context, are submitted as `write` entries.
- A failed run reports `runFailure` to the client. Use the `afterFailedRun: "continue"` setting so queued messages are not left stranded.
- `maxTurns` is a safety limit on tool rounds with a Service-wide default of 50. A Bot's own value overrides the default; an unset or null Bot value means 50. There is no unlimited setting.

### Compaction

pi-durable's automatic compaction is enabled, with background compaction on. Defaults come from pi-durable, and `modelOverrides` supports policies for small-context models once their budgets are decided. A user-visible notice in the transcript shows when compaction happened. Older entries stay in storage for memory and search.

**Keeping authors through compaction.** The `beforeCompact` hook uses the conversation's model to write a structured digest of the entries being compacted, using their author metadata and model messages. The digest identifies who said what, decisions, and open items, preserving prior summary context. If that model call fails or produces an incomplete summary, the hook defers to pi-durable's own summarizer. Entries kept verbatim are not summarized again.

Non-user entries such as Bot mail and Group Thread entries carry their author label in visible text. A formatting helper is available; these entry write sites are implemented with the corresponding features. A fake-model attribution test checks the digest path, and each default model needs a manual run before launch.

### Models and providers

- **Keys:** provider keys live in the app's [secret store](#secrets), never in a plain file where a keychain is available.
- **Settings screen:** you add a provider by protocol, either OpenAI-compatible or Anthropic Messages, with a name, base URL, and key. Built-in `pi-ai` providers can be added with only a key. No provider gets special-case code.
- **Per-Bot model:** each Bot has an optional model. An unset Bot uses one Service-wide default. A change applies from that Bot's next Turn. The Service default is set in Settings; nothing reads `~/.pi`.

### Tools

Tools are app extensions in the registry. Each Bot's conversation selects its extensions.

| Extension | Tools | Notes |
| --- | --- | --- |
| Files and shell | `read`, `write`, `edit`, `bash` (PowerShell on Windows, with the cross-platform work) | pi-durable's tools from `@earendil-works/pi-durable/tools`, installed under an app extension name, with an app execution environment. See [File access](#file-access). |
| Computer | computer | Unchanged behavior over the computer protocol |
| Browser | browser | Unchanged |
| Web | `web_fetch`, `web_search` | See [Web](#web) |
| Bot mail | send and read Bot mail | Unchanged behavior; calls the mailbox module directly |
| Local Sidecar | local tools | Unchanged protocol |
| Plugins | plugin management | Connects and signs in to service accounts, and installs, enables, and removes Skills and MCP servers. Calls the plugins module directly. Calls to a connected service go through `mcp`. |
| MCP | one `mcp` tool with search, describe, and call | For servers in `.mcp.json` and connected service accounts. See [MCP](#mcp) |
| Secrets | `secrets` with save, list, and delete | See [Secrets](#secrets) |

This table is the complete list of Bot tools. Code mode and tool search from pi-durable are not used in v1.

### File access

**The workspace is not a sandbox.** Bots run as your OS user. File-access rules are a guard against mistakes, not a security boundary, and the product wording says so. A real sandbox is later work: an OS-level sandbox per platform, such as bubblewrap on Linux, Seatbelt on macOS, and AppContainer on Windows.

**Allowed folders** are where Bots can read and write without asking:

- the Shared Workspace
- your Downloads folder, found per platform
- any folders you add in Settings

**Outside the allowed folders**, `read`, `write`, and `edit` pause and ask you first. The request names the Bot, the action, and the path. You can answer:

- **Allow once**
- **Always allow this folder**, which adds it to the allowed folders
- **Deny**

A denied call returns an error result to the Bot, which tells it you said no.

**Always refused**, even with approval:

- the Service data and state directories, which hold memory, secrets, and sessions
- the secret store's fallback file
- another Bot's private folder

Path checks resolve symbolic links and `..` before comparing.

**The shell:**

- `bash` starts in the Shared Workspace.
- It runs with your user's rights, and its commands are not checked against the allowed folders, because that cannot be enforced without an OS sandbox.
- It has a time limit, 120 seconds by default and 600 at most, and honors abort.
- It starts with a clean environment: the Service's own environment variables are not passed on, so no app secret reaches it that way.
- This is the main reason the workspace is not a sandbox, and the wording says so.

**Example:** "Download this PDF to my Downloads." The Bot fetches it into the Shared Workspace or straight into Downloads, which is allowed by default, so nothing is asked.

**Approval flow:** the runtime owns one approval flow, and file access is its first user.

- **How it pauses:** pi-durable 1.5.2's `beforeTool` cannot wait for a person. So `beforeTool` only decides whether approval is needed. A tool that needs it runs as a durable tool task marked safe to replay. The task records a pending approval in Service storage, then waits for its answer inside the running tool task, as the prototype did, because a tool cannot sleep durably in pi-durable 1.5.2. It wakes as soon as the answer arrives and checks the stored record at least once a minute.
- **Clients** show the request on the Thread and in notifications.
- **Restarts:** the request survives. On `resume()` the task runs again, finds the stored request, and keeps waiting instead of asking twice. Each Service crash while it waits uses one of pi-durable's restarts for that run (5 by default). A Service shutdown is a clean stop and does not use one.
- **Effects must be safe to repeat:** an approved tool may run again after a crash, so every tool that changes something after approval records its execution and checks it before acting. `write` and `edit` record the file's digest before changing it. A rerun applies the change only if the file still has that digest, treats a `write` whose content is already there as done, and otherwise returns an error that asks the Bot to read the file again. "Done once" is a property of each tool, not a general exactly-once guarantee from pi-durable.
- **Expiry:** an unanswered request expires after 7 days, and the tool returns a "no answer" error to the Bot.
- The proactive-Bots spec reuses this flow for ask-before-act.

### Secrets

Bots can keep sensitive data privately, such as passwords, tokens, and account numbers. The app keeps its own secrets, provider keys and MCP sign-ins, in the same store.

- **Store:** the OS keychain: Secret Service on Linux, Keychain on macOS, and Credential Manager on Windows. Where no keychain is available, such as a server without Secret Service, the Service falls back to a file in its data directory readable only by your user, and Settings warns that a Bot's shell could read it. Keychain access uses Bun's built-in `Bun.secrets`, so the store adds no dependency. On start, the Service checks the keychain with a short write, read-back, and delete under a time limit, so a locked keyring cannot hang it. Once a data directory's secrets have moved to the keychain, a marker records it. After that, a keychain outage is reported as an error, and the Service never quietly writes a plaintext file again.
- **Scopes:** app secrets are never available to Bots. Each Bot's secrets are private to that Bot: other Bots cannot list or use them.
- **The `secrets` tool:** save a value under a name with a short description, list names and descriptions, and delete. It never returns a value.
- **Use by name:** a Bot writes `{{secret:name}}` in a `bash` command or its environment, a `web_fetch` URL or header, or an `mcp` call's arguments. The app fills in the value when the tool runs. Before a result is stored or sent to the model, every exact occurrence of a value used in that call is replaced with its `{{secret:name}}`.
- **Never stored elsewhere:** secret values never go into `pi_` entries, Service Messages, logs, or memory.
- **Typing a secret into a Thread** sends it to the model like any message. Settings lists each Bot's secrets by name and lets you add, replace, and remove them without the model seeing the value.
- **Bot Deletion** removes that Bot's secrets, and the confirmation says so.
- **Limits, stated honestly:** replacing values catches exact copies, not changed ones, such as a value a script re-encodes. A Bot that runs a command using a secret can still send it somewhere through that command. This keeps secrets out of the model's sight; it does not stop a Bot told to misuse one. The keychain is not a sandbox either. A Bot's shell runs as you and can ask the keychain for a value directly, for example with `secret-tool`. The keychain keeps secrets out of files, backups, and the model's view; only an OS sandbox around the shell, which is later work, would stop a Bot that tries.

### Prompt and Skills

- **Prompt:** the system prompt is built only from app sections: the Base Prompt, the Bot's identity and Job, workspace and private-folder guidance, the allowed folders, the Skills list, and per-Turn context.
- **No auto-loading:** `AGENTS.md` and similar files are not auto-loaded.
- **Skills:** one folder, `<workspace>/.agents/skills`. pi-durable has no Skills loader, so an app section lists each Skill's name and description from its `SKILL.md` frontmatter, and the Bot reads a Skill with `read` when it needs it. Global folders such as `~/.pi/agent/skills` and `~/.agents/skills` are not loaded. Skills installed from the catalog in the Skills panel are installed into this folder.

### MCP

- **Client:** `pi-mcp` for connections (stdio and Streamable HTTP) and OAuth (`@earendil-works/pi-mcp/oauth`).
- **Configuration:** servers you add live in `<workspace>/.mcp.json`. Service accounts connected in the plugins panel are MCP servers too. Both go through the same `mcp` tool and the same app-owned sign-in.
- **Tool shape:** the Bot sees one `mcp` tool with search, describe, and call, as today, so many services do not fill the prompt. Servers connect on first use.
- **Sign-in:** `pi-mcp` stores no credentials and opens no browser, so the Service owns sign-in:
  - an `McpOAuthStateStore` backed by the app secret store, holding client registration, tokens, and pending sign-in state
  - a loopback callback listener on `127.0.0.1` for the browser redirect
  - a sign-in action in the Services panel that opens the authorization URL on the user's device
- **Panel:** the Services panel's status and control behavior is unchanged.
- **Not in v1:** sampling, elicitation, and MCP app UI panels.

### Web

Bots get two web tools built by the app:

- **`web_fetch`** reads a URL as text, without a browser. It extracts the readable part of a page with `@mozilla/readability` on `linkedom` and returns Markdown through `turndown`.
- **`web_search`** works with no setup, through Exa's free MCP endpoint (`https://mcp.exa.ai/mcp`) called with `pi-mcp`. Settings can add an Exa API key, which removes the free endpoint's rate limit, and Settings says that searches without a key go to Exa's free service. Search providers sit behind one small interface, so others can be added later. Exa is the only one in v1, and any other search service can be connected through MCP.
- **When search fails:** a rate limit, either HTTP 429 or a 200 response with the `ai.exa/rateLimited` flag, is reported as a rate limit and never as an empty result. On a rate limit or outage, the tool says so and suggests the browser tool.
- **Internal addresses:** `web_fetch` refuses internal addresses, so a page cannot steer a Bot into local services. Settings can exempt address ranges, which is needed when a proxy maps hostnames to fake addresses. The exemption is off by default, and the error names the range and the setting.
- **Limits:** a download is capped at 5 MB and has a time limit, and page extraction runs in a worker thread with its own time limit, so a large or hostile page cannot freeze the Service.
- **Trust:** results count as outside content for the memory trust rules.

### Workspaces

```
<workspace>/
├─ work files            shared by all Bots
├─ .agents/skills/       the only Skills folder
├─ .mcp.json             the only MCP configuration file
└─ bots/<bot-id>/        each Bot's private folder
```

- **Shared Workspace:** common to all Bots. The default working folder stays the Shared Workspace, and explicit Thread working folders are unchanged.
- **Private folder:** each Bot has one at `<workspace>/bots/<bot-id>/`, created on its first Turn and named by Bot ID, so renaming the Bot does not move it. It holds only the Bot's notes about itself, such as how it does its Job. All work files, including drafts, go in the shared space. The Service does not inspect content, so this relies on the app prompt.
- **Enforced where the Service can:** app file tools and Local Sidecar transfers refuse paths inside another Bot's folder. The shell runs as your user, so another Bot can still read the folder that way, and the wording says so.
- **Not here:** memory, Bot sessions, and secrets stay in Service-owned storage, so a Bot's file tools cannot edit its own memory.
- **Bot Deletion** removes the Bot's private folder, and the confirmation says so. The rest of the Shared Workspace stays.
- **One place for each:** the runtime reads Skills only from `.agents/skills` and MCP servers only from `.mcp.json` and connected service accounts. There is no cleanup of old `.pi`, `.codex`, or `.claude` folders before public release.

### Platform paths

All data, workspace, and Downloads paths come from one module that knows each platform: XDG on Linux, `~/Library/Application Support` on macOS, and `%APPDATA%` on Windows. Today's Linux paths stay where they are until the rename spec moves them. Nothing in the runtime assumes Omarchy, Sway, or Linux.

### Hook points for later specs

The runtime installs the following hooks but does not fill them:

| Hook | pi-durable feature | Used by |
| --- | --- | --- |
| Per-request context | `beforeRequest` (changes one request, never stored) | Memory recall |
| After a reply | `afterRun` returning durable tasks | Memory learning |
| Before a tool | `beforeTool` plus the approval flow | File access now, ask-before-act later |
| Durable tasks and timers | `defineTask`, `sleepUntil`, child tasks | Proactive Bots: check-ins, reminders, watchers |
| Input without a reply | `write` submissions | Proactive Bots, Bot mail |

### Product model and documents overridden

- **Retire:**
  - the Agent picker, Pending Agents, and Agent conformance
  - adapter plans
  - the agent worker and its protocol
- **Rename:** "Native Session" becomes "Bot session".
- **Agent identity fields:** these stay in storage until nothing reads them.
- **Documents to amend:** this overrides the earlier documents listed in the previous spec: ADR 0002, Agent Integration ADR 0003, `docs/agents-integration.md`, ADRs 0006 and 0009, the product boundary, and the README. These were removed from `docs/` in commit 713b4d5, so each is amended or replaced only if it is restored.

## Commands

```
bun install --frozen-lockfile
bun run typecheck
bun run lint:boundaries
bun test apps/daemon
bun test                 # full Bun suite
bunx playwright test -c tests/e2e # legacy Service fixture
OMARCHY_BOT_DEV=1 bun run dev
```

## Project structure

```
apps/daemon/src/modules/runtime/      new: the only importer of pi-durable
  runtime.ts                          Harness lifecycle, public API for other modules
  conversations.ts                    Thread ↔ conversation mapping
  transcript.ts                       entries → Service Messages and client stream
  models.ts                           secret store → pi-ai providers
  secrets.ts                          OS keychain store, the secrets tool, value filling and replacing
  approvals.ts                        approval requests
  extensions/                         files-shell, computer, browser, web, mail, local, plugins, mcp, secrets, skills
  *.test.ts                           tests next to the code
apps/daemon/src/modules/workspace/    allowed folders, private folders, platform paths
workers/pi/                           removed
packages/agent-contract/              agent-protocol removed; tool protocols kept
```

Lint boundaries must forbid importing `@earendil-works/pi-durable` outside `modules/runtime`.

## Code style

Follow the existing daemon modules. Other modules call the runtime through its own types:

```ts
export interface BotRuntime {
  startTurn(threadId: ThreadId, input: TurnInput): Promise<TurnHandle>;
  steer(threadId: ThreadId, text: string): Promise<void>;
  abort(threadId: ThreadId): Promise<void>;
  watch(threadId: ThreadId, onUpdate: (update: ThreadUpdate) => void): Promise<() => Promise<void>>;
  deleteBot(botId: BotId): Promise<void>;
}
```

## Testing strategy

- **Runtime module:** test against pi-durable `MemoryStorage` and a fake model provider, using `pi-ai`'s test or fake stream support. Cover:
  - Turns and streaming
  - ordered blocks
  - Steering and follow-up
  - abort
  - failed runs
  - compaction
  - deletion
- **Restart:** test against SQLite storage in a temporary file. Kill mid-reply, reopen, and check that `resume()` continues or fails the reply visibly. Do the same with a pending approval.
- **Service tests:** existing Thread, mailbox, and lifecycle tests switch from the fake worker to the runtime with a fake model. Their assertions should not change.
- **File access:**
  - allowed folders, the Downloads default, and folders added in Settings
  - outside a folder asks first, with allow once, always allow, and deny
  - symbolic link and `..` escapes are refused
  - the data directory and other Bots' folders are always refused
- **No migration:** a Thread's first Turn on this runtime starts an empty conversation, each Bot keeps its model, and nothing reads or writes `~/.pi`.
- **Providers:** check that one OpenAI-compatible provider and one built-in `pi-ai` provider each complete a Turn.
- **Web:** rate limits on both signals, the internal-address refusal and its exemption, and the size and time limits.
- **Private folders:** creation, rename, refusal from another Bot, and removal on Bot Deletion.
- **Secrets:** a value is filled in at run time and replaced in the result; another Bot cannot list or use it; it never appears in entries, Messages, or logs; the fallback file and its warning; fallback values move into the keychain once it is available.
- **Deleting conversations:** Bot Deletion and a memory reset leave no rows for the conversation in any `pi_` table.
- **Real scenarios:** run the computer and browser scenarios and a small set of everyday tasks on the Bot runtime. Nothing is compared with the removed worker.
- **Boundary:** `bun run lint:boundaries` fails on a pi-durable import outside the runtime module.

## Boundaries

- **Always:**
  - pin Pi packages exactly
  - keep pi-durable behind the runtime module
  - run the prototype checks as tests on every Pi upgrade
  - keep the "not a sandbox" wording accurate
- **Ask first:**
  - changing the Service database schema beyond the `pi_` tables and approval records
  - adding a dependency
  - widening the default allowed folders
- **Never:**
  - keep a secret value in entries, Messages, logs, or memory
  - write to `~/.pi`
  - load the user's Pi packages
  - install pi-durable's tools without the app execution environment
  - name a specific personal gateway in product code or docs

## Out of scope

- Memory, which has its own spec, and proactive behavior (check-ins, reminders, watchers, notifications), which needs a new spec. This spec only provides their hooks.
- The cross-platform restructure, mobile client, and rename.
- An OS-level sandbox.
- Other agents, multi-Agent support, Mastra, and TanStack AI as the runtime. TanStack's client libraries may be considered in the restructure spec.

## Prototype

This runs outside product code, with a real provider key and a small model allowance. It passes when one script does all of these:

1. Completes a streaming Turn through a standard `pi-ai` provider (for example `opencode-go`) under Bun. pi-durable SQLite storage sits in a copy of the Service database under `pi_`, and neither `pi-coding-agent` nor `pi-agent-core` is in the dependency tree.
2. Adds a recall line in `beforeRequest`, and shows it reached the model but is not in the stored entries.
3. Schedules a reminder task with `sleepUntil`, kills and restarts the process, and shows the reminder posts into the existing conversation.
4. Migrates a copy of a real old session file into a conversation and continues it.
5. Streams a conversation through `watch()` to the web client, including a reconnect.
6. Pauses a `write` outside the allowed folders for approval, restarts the Service, approves, and shows the file written once.
7. Calls a tool on a real MCP service through `pi-mcp`, including an OAuth one, and reports whether existing `pi-mcp-adapter` tokens can be imported.
8. Steers a reply while a tool call is running, and compacts a long conversation.

A failed check is solved within pi-durable, through a workaround in the runtime module, an adapter, or an upstream fix. This spec is updated to match before tickets are written.

### Results (2026-11-12)

The prototype is in `prototypes/bot-runtime/` on branch `proto/bot-runtime`, with evidence for each check in its README.

| # | Result | Notes |
| --- | --- | --- |
| 1 | Pass | Bun 1.4.4 runs `node:sqlite`; no `pi-coding-agent` or `pi-agent-core` in the tree |
| 2 | Pass | Recall reached the request; no recall text in `pi_` entries |
| 3 | Pass | Reminder posted once into the same conversation after a hard kill |
| 4 | Pass | Real session continued, with old messages flattened to labeled text; see [Storage](#storage) |
| 5 | Pass | Tested with a small page, not the real web client. A Service restart while a client is disconnected is untested. |
| 6 | Pass with a workaround | `beforeTool` cannot wait; see the [approval flow](#file-access) |
| 7 | Done | A real MCP tool call passed. OAuth sign-in stopped at the human step and was accepted as done; see [MCP](#mcp). |
| 8 | Pass | Steering during a tool call and compaction work; compaction can lose authors, see [Compaction](#compaction) |

## Changes

- **2026-11-12:** prototype results folded in.
- **2026-11-24:**
  - compaction keeps authors with an app-written summary, and `maxTurns` defaults to 50
  - a Service restart marks interrupted Turns as failed, and an abort removes the incomplete reply
  - Threads cannot be deleted, only Bots; the runtime module deletes conversations itself until pi-durable has a public delete
  - Bot secrets and one secret store in the OS keychain, replacing the credential file
  - plugins manage accounts and Skills, and every MCP call goes through `mcp`; catalog Skills install into the workspace Skills folder
  - the web tools are built by the app with three pinned libraries, and the Web and Workspaces rules are copied in from the earlier draft
  - a clean shutdown keeps a reply that is waiting for approval, and the approval wait runs inside its tool task (Task 9)
- **2026-11-25:**
  - the keychain is reached through Bun's built-in `Bun.secrets` (no new dependency), with a start-up check and a marker so a keychain outage fails closed, and Bun is pinned exactly to 1.4.5
  - the secret limits say plainly that the keychain does not stop a Bot's own shell
  - no migration of earlier data before the app is public: the old session migration, `~/.pi` import, token import, credential-file move, and workspace cleanup are removed
- **2026-11-26:**
  - the real scenarios run on the Bot runtime only, with no before-and-after comparison against the removed worker

## Open questions

None that block implementation tickets.

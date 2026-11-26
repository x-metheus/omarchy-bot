# Bot runtime on Pi core

> **Superseded** on 2026-11-10 by [docs/specs/bot-runtime.md](../../docs/specs/bot-runtime.md) and [ADR 0016](../../docs/adr/0016-build-bots-on-pi-durable.md). Kept for history.

Status: ready-for-agent

> Run the [prototype](#prototype) first, once the user says go. Its results may change this design, so no tickets until it passes.

## Problem Statement

Bots run on Pi's coding-agent layer today. It is a coding product: its package describes itself as a "coding agent CLI", and it brings its own default prompt, tools, resource discovery, and extension system. The user wants personal agents, not coding agents, and has decided that Bots will be built on Pi core alone, without other coding agents.

## Solution

Omarchy Bot gets one Bot runtime, built on `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. `pi-coding-agent` is not used. The app owns the prompt, tool set, and context on every model call. The multi-Agent product model is retired: there is no Agent picker, no Agent adapters, and no capability inventory for other backends.

## User Stories

1. As an Omarchy user, I want every Bot to behave as a personal assistant, so that coding-agent defaults do not shape it.
2. As an Omarchy user, I want to create a Bot without choosing an Agent, so that I only decide who the Bot is.
3. As an Omarchy user, I want my existing Bots, Threads, and transcripts kept through this change, so that I lose no history.
4. As an Omarchy user, I want my existing Threads to continue working after the change, so that conversations do not break.
5. As an Omarchy user, I want to keep using my existing model logins, so that I do not have to pay separately for API keys.
6. As an Omarchy user, I want to choose which model my Bots use, so that a Bot no longer depends on a coding agent's settings.
7. As an Omarchy user, I want computer, browser, Bot mail, Local Sidecar, and plugin tools to keep working, so that Bots lose no abilities.
8. As an Omarchy user, I want my connected MCP services to keep working, so that Bots keep access to my accounts.
9. As an Omarchy user, I want my Skills to keep working, so that reusable instructions are not lost.
10. As an Omarchy user, I want Steering, streaming, Thinking, and ordered Tool Calls to behave as today, so that conversation quality does not drop.
11. As an Omarchy user, I want long conversations to keep working through compaction, so that a Thread does not run out of context.
12. As an Omarchy user, I want a stuck or crashed runtime to fail its Turn clearly and recover, so that one failure does not take down the Service.
13. As an Omarchy user, I want each Bot to have a private folder inside the Shared Workspace for information about itself, so that it stays apart from work files.
14. As an Omarchy user, I want the Shared Workspace to stay common to all Bots, so that they can still work on the same files.
15. As an Omarchy user, I want to be told honestly what a private folder protects, so that I do not mistake it for a security boundary.
16. As an Omarchy user, I want all work files in the shared space, including drafts, so that I and other Bots can always find them, and deleting a Bot loses no work.
17. As an Omarchy user, I want my Bots to search and read the web, so that a personal assistant is not cut off from current information.
18. As an Omarchy user, I want my current model provider to keep working, so that Bots do not stop on upgrade.
19. As an Omarchy user, I want the workspace to hold one Skills folder and one MCP file, with old folders backed up, so that nothing is lost and there is one place to look.

## Implementation Decisions

### What Pi core supplies

Read from the 0.84.4 code; not yet run:

- **Agent loop:** the `Agent` class with streaming, tool execution, steering, follow-up, and abort.
- **Per-call context control:** `transformContext` and `convertToLlm` run before each model call and do not change stored messages. Memory recall depends on this.
- **Building blocks:** session storage, `prepareCompaction` and `compact`, `loadSkills`, `formatSkillsForSystemPrompt`, and `bash`, `read`, `write`, `edit`, and image tools.
- **Models:** `pi-ai` supplies `createModels`, the `CredentialStore` interface, and built-in providers including `opencode-go`.

### Runtime composition

**Use `Agent` plus selected pieces, not `AgentHarness`.** `AgentHarness.create` throws `HarnessNotImplemented("create.restore")` when a session already has records, so it cannot resume a Thread in 0.84.4.

One supervised Bot worker runs the app's own session module, which owns:

- creating an `Agent` per Bot session, with the app-assembled prompt, the Bot's model, and the tool set
- appending messages to the session and rebuilding context from it on resume
- running compaction when the context is nearly full, between turns
- mapping `Agent` events to the existing worker protocol

The worker protocol does not change, so the Service, Threads, mailbox, and clients are not affected by this swap.

### What is replaced

| Today, from `pi-coding-agent` | New |
| --- | --- |
| `createAgentSession`, `AgentSession` | App session module above |
| `SessionManager` | Core session, one JSONL file per Thread in the Service's data directory |
| `ModelRuntime`, `AuthStorage` | `createModels` with an app `CredentialStore` |
| `defineTool` | Core's tool type, for computer, browser, mail, local, and plugin tools |
| `DefaultResourceLoader` | `loadSkills` on one folder; nothing else is discovered |
| Extensions | None. The tool set is an explicit list in the app |
| `pi-mcp-adapter` extension | Bot MCP client below |

### What Bots lose unless replaced

Bots load the user's global Pi packages today. Core has no extension system, so none of these load any more:

| Package in `~/.pi/agent/settings.json` | Decision |
| --- | --- |
| `@x-magpie/pi` (the default model provider) | **Must keep:** see Models and logins |
| `pi-web-access` (web search and fetch) | **Must replace:** see Web |
| `pi-mcp-adapter` | Replaced by the Bot MCP client |
| `computer-use-linux` | Drop; Bots have the computer tool |
| `pi-fff`, `pi-subagents`, `context-mode`, `rpiv-todo` | Drop; these are coding-agent aids, and Bots have Bot mail for working together |

The user's own `pi` command and its settings are untouched.

### Models and logins

- **The core has no model settings.** The app passes a model to each `Agent`.
- **Decision:** each Bot has an optional model. An unset Bot uses one Service-wide default in app Settings. A change applies from that Bot's next Turn. Reply Decisions and Background Review use the same Bot's model.
- **Migration:** the default is seeded once from the current Pi default, so existing Bots keep their model.
- **Keys:** an app `CredentialStore` reads `~/.pi/agent/auth.json`, the same file Pi uses. It holds only API keys today, so no token refresh race applies yet. If OAuth providers are added, the store must honor Pi's file lock.
- **magpie:** the current default provider comes from a Pi extension, which core cannot load. `@x-magpie/pi` builds a provider object and passes it to `registerProvider`, so the app should pass the same kind of object to `models.setProvider`, reading `providers.magpie` from `~/.pi/agent/models.json`. The extension package itself declares `pi-coding-agent` as a peer, so use `@x-magpie/core`, which has no such dependency, or a small app provider. The prototype decides which.
- **Login:** keys are added today by running `pi`. A Settings screen for adding a provider and key is needed if the product no longer installs the `pi` command. Check what the installer provides.

### Bot MCP client

`pi-mcp-adapter` has 72 source files, and 18 import `pi-coding-agent`, mainly its extension layer. Its `config` and `oauth` entry points do not appear to, directly.

- **Connections and calls:** a small app module using the official MCP SDK.
- **Configuration and sign-in:** keep importing the adapter's `config` and `oauth` entry points at the pinned version, so that existing connections and tokens keep working. Confirm this loads without `pi-coding-agent`.
- **Tool shape:** one `mcp` tool with search, describe, and call, as Bots use today, so many services do not fill the prompt with tool schemas. Servers connect on first use.
- **Control:** the `mcp.control` worker command and status shape stay, so the Services panel does not change.
- **Not carried over in v1:** MCP sampling, elicitation, and app UI panels. Check that no connected service needs them.

### Web

A personal assistant must be able to use the web. Bots get first-party tools:

- `web_fetch`: read a URL as text, without a browser.
- `web_search`: works with no setup, through Exa's free MCP endpoint (`https://mcp.exa.ai/mcp`). This is what Bots use today, because this install has no `web-search.json` and no search keys.
- **Search settings:** Settings can add an Exa API key, which removes the free endpoint's rate limit. Providers sit behind one small interface, so others can be added later. Exa is the only one in v1, and any other search service can be connected through MCP.
- **When search fails:** Exa's free endpoint can answer a rate limit with HTTP 200 and a `ai.exa/rateLimited` flag, so the tool checks for both that and HTTP 429. On a rate limit or outage, it says so and suggests the browser tool. A rate limit is never returned as an empty result.
- **Internal addresses:** `web_fetch` refuses internal addresses, so a page cannot steer a Bot into local services. Settings can exempt address ranges, which is needed when a proxy maps hostnames to fake addresses. This machine needs it: the last recorded `pi-web-access` fetch failed with `Blocked internal address` on `198.18.0.108`. The exemption is off by default, and the error names the range and the setting.

Results count as external content for the memory trust rules. `pi-web-access` cannot be loaded as it is, because it is written against the extension API. It is MIT licensed, so its Exa client and address guard can be adapted with attribution.

### Skills

- **One folder:** `~/.omarchy-bot/workspace/.agents/skills`, loaded with `loadSkills` and listed with `formatSkillsForSystemPrompt`.
- **Global folders stop loading:** `~/.pi/agent/skills` and `~/.agents/skills` are the user's coding-agent setup. A user who wants one of those for Bots copies it to the shared folder. The `skill-creator` Skill stays.

### Tools and instructions

- **Shell and file tools stay.** A personal agent with a computer needs them. They run as the same OS user, so OS-level isolation is later hardening.
- **`AGENTS.md` is not auto-loaded.** Prompts stay wholly app-owned. A Bot can read such a file when it chooses, and Skills and Job/Instructions remain the supported way to give standing instructions.

### Sessions

- **Location:** `<dataDir>/sessions/<bot-id>/<thread-id>.jsonl`, under `~/.local/share/omarchy-bot` by default, and so outside the Shared Workspace. Deleting a Thread or Bot deletes these files.
- **Old format differs:** coding-agent sessions are format version 3, and core's records add entries such as `operation_started` and `queue_enqueued`. Both have `message` and `compaction` entries.
- **Migration on a Thread's first Turn after upgrade:** read the old file, read-only. Take the latest compaction summary and the messages after it, and write them to a new session. If this fails, seed the new session from the Service transcript and add a note to the Service log. The Thread continues either way.
- **Old files:** left in place until the Bot or Thread is deleted. Deletion then removes the old file too, but only the exact path recorded for that Thread.

### Workspace cleanup

With Pi core only, the workspace needs one Skills folder and one MCP file:

```
~/.omarchy-bot/workspace/
├─ work files                 shared by all Bots
├─ .agents/skills/            the only Skills folder
├─ .mcp.json                  the only MCP configuration
└─ bots/<bot-id>/             each Bot's self information
```

A one-time migration runs at Service start, after the new runtime is in place:

1. **MCP:** servers in `.pi/mcp.json` and `.codex/config.toml` that are missing from `.mcp.json` are added to it. If the same name differs, `.mcp.json` wins, and the conflict is recorded in the Service log.
2. **Skills:** Skills in `.pi/skills` and `.claude/skills` missing from `.agents/skills` are moved there. If the same name exists, `.agents/skills` wins.
3. **Old folders:** `.claude`, `.codex`, and `.pi` are moved, not deleted, to `<dataDir>/backups/workspace-<date>/`, including anything the migration did not recognize. This also removes the stale adapter path in `.pi/settings.json`.
4. **Failure:** if any step fails, nothing is moved, and the Service reports it and retries on next start. A marker file prevents a second run.

Code that stops: the reconciliation of three MCP files in `NativeMcpStore`, the extra Skills roots in `NativeSkills`, and the adapter entry written to `.pi/settings.json`. This changes the [shared plugins specification](../shared-plugins-native-discovery/spec.md). The Skills and Services panels otherwise behave the same.

### Workspaces

The Shared Workspace stays the common space for all Bots, at `~/.omarchy-bot/workspace`. Each Bot gains one private folder inside it:

```
~/.omarchy-bot/workspace/          shared by all Bots
~/.omarchy-bot/workspace/bots/<bot-id>/   this Bot's private folder
```

- **Named by Bot ID,** so renaming a Bot does not move it. Created on the Bot's first Turn.
- **Default cwd stays the Shared Workspace,** so existing Threads and shared work do not change. Explicit Thread cwd values are also unchanged. The Base Prompt tells each Bot where its private folder is, and what goes where.
- **Private folder is for self information only:** notes a Bot keeps about itself, such as how it does its Job. **All work files go in the shared space,** including drafts. The Service does not inspect content, so this relies on the Base Prompt.
- **Enforced where the Service can:** app tool wrappers and Local Sidecar transfers refuse paths inside another Bot's folder. `confinedWorkspacePath` confines transfers to the whole Shared Workspace today, so it needs the calling Bot's identity.
- **Not a security boundary:** a shell runs as the same user, so another Bot can still read the folder that way. The wording must say so. OS-level isolation is later hardening.
- **Memory and Bot sessions do not live here.** They stay in Service-owned storage, so a Bot's file tools cannot edit its own memory.
- **Deletion (confirmed by the user):** Bot Deletion removes the Bot's private folder, and the confirmation says so. The rest of the Shared Workspace survives. Keeping work files out of the private folder means this should not lose work.

### Product model

- **Retire:** the Agent picker, Pending Agents, conformance for other Agents, and plans for other adapters.
- **Keep the worker process boundary:** the runtime still runs in a supervised worker process, because process isolation and the worker protocol protect the Service from runtime failures, and the worker protocol stays the seam for tests.
- **Bots no longer choose an Agent.** Existing Bots migrate to the single runtime. Agent identity fields can be removed in a later cleanup, once nothing reads them.
- The term "Native Session" becomes "Bot session", now owned by the app, not a vendor.

### Accepted documents this overrides

Implementation must amend these explicitly, through a new system ADR:

- **ADR 0002:** each Bot references an Agent, and several Bots may use one.
- **Agent Integration context and ADR 0003:** preserving native Agent prompts, capabilities, and approval behavior.
- **`docs/agents-integration.md`:** the adapter inventory, and Agents becoming selectable through conformance.
- **ADR 0006:** deletion semantics are written around Agent-owned Native Sessions. App-owned sessions can now really be deleted, which is better for users, and memory deletion depends on it. It also says Shared Workspace files survive deletion, and private folders are now the exception.
- **ADR 0009 and the Workspace glossary:** Shared Workspace files are common to all Bots, and "Per-Bot workspace" is a term to avoid. Add **Private Folder** as a part of the Shared Workspace.
- **Product boundary and README:** the product model and support statements.
- **Pi business MCP execution:** the product boundary assigns it to the pinned `pi-mcp-adapter`.

### Migration

- Service-owned Bots, Threads, Messages, and attachments do not change.
- Sessions and the workspace migrate as set out in [Sessions](#sessions) and [Workspace cleanup](#workspace-cleanup).

## Testing Decisions

- **Primary seam:** the existing worker protocol, which already has a fake worker for Service-level tests, so existing Thread, mailbox, and lifecycle tests should pass unchanged.
- **Runtime conformance:** keep real-runtime scenarios for streaming, ordered blocks, Steering, abort, tools, session restore, compaction, and attachments. These replace Agent conformance.
- **Regression:** re-run the real computer and browser scenarios, and compare a small set of everyday tasks before and after.
- **Migration:** test upgrade on a database and session files from the current release, and that each Bot keeps its model.
- **Keys and providers:** test that the app reads existing keys without changing `auth.json`, and that `magpie` and one built-in provider both complete a Turn.
- **Sessions:** test a Thread resuming after upgrade from a real old session file, from a corrupt one, and with no file.
- **Cleanup:** test the migration against a copy of a real workspace: servers and Skills merged, conflicts resolved as specified, unknown files kept in the backup, a failure moving nothing, and a second start doing nothing.
- **Web:** test both tools, keyless search, search with a key, both forms of rate limit, and that `web_fetch` refuses internal addresses unless their range is exempted.
- **Private folders:** test that it is created lazily, keeps its path on rename, is removed by Bot Deletion without touching shared files, and that app tools and Sidecar transfers refuse another Bot's folder.

## Out of Scope

- Memory, Group Threads, routines, approvals, and messaging channels, which have their own specs.
- Other coding agents, and Rig.
- Removing Agent identity fields from storage, beyond what the migration needs.

## Further Notes

- **Package stability:** Pi moves quickly, and `AgentHarness` is unfinished, which is why this design uses `Agent` directly. Keep Pi pinned, as now.
- **Other Agents:** this reverses a stated product direction. The worker protocol keeps the door open technically, but no work should preserve multi-Agent support for its own sake.

## Prototype

Comes after this spec is agreed. It stays outside the product code, and uses the real keys and a small amount of model allowance. It passes when one script does all of these:

1. Completes a streaming Turn on `Agent` through `magpie`, using keys read from `auth.json`, with no `pi-coding-agent` in its dependency tree.
2. Injects a recall line through `transformContext`, and shows it reached the model but is absent from the stored session.
3. Calls one tool on a real connected MCP service, including one that uses OAuth, with the adapter's `config` and `oauth` entry points.
4. Stops, resumes the same session from disk, and continues the conversation.
5. Imports a copy of a real old session file and continues from it.
6. Runs compaction on a long session.
7. Applies Steering during a Turn with a running tool call.
8. Gets real results from `web_search` with no key, and reads a page with `web_fetch` on this machine with `198.18.0.0/15` exempted.

Any failure changes this spec before tickets are written.

## Resolved Decisions

1. **Web search provider:** Exa's free endpoint by default, with an optional key in Settings.
2. **Global Skills:** `~/.pi/agent/skills` and `~/.agents/skills` stop loading for Bots.

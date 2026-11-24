# ADR 0016: Build Bots on pi-ai and pi-durable

## Status

Accepted on 2026-11-10.

## Date

2026-11-10

## Context

The product is changing from an Omarchy app that hosts coding agents into a self-contained, cross-platform personal-agent app. The confirmed intent (2026-11-10):

- Bots are personal agents. They handle life and computer tasks, not code, and start things on their own: scheduled check-ins, follow-ups, watching for changes, and suggestions they ask about before acting.
- Memory the user never has to correct is the main measure of success.
- The runtime, memory, computer use, browser, web, and MCP ship inside the app. Nothing depends on the user having Pi or another agent installed.
- The app owns the model and login layer.
- Bots run on a desktop or server. Desktop and future mobile apps are clients of one Bot service.

This reopens the 2026-11-05 decision to build on `pi-agent-core` 0.84.4 (`.scratch/bot-runtime/spec.md`). Options are judged on memory, proactive work (schedules, waiting, watching, background tasks), crash recovery, stability, client support, and fit with the app's own login layer and Service. Pi core, pi-durable, Mastra, and TanStack AI were compared.

### Facts checked on 2026-11-10

Package contents were read from npm.

**Pi `pi-agent-core` 1.5.1** (MIT):
- It is only an agent loop: about 1,400 lines of JS, built on `pi-ai`.
- The session, compaction, skills, and tools modules that existed in 0.84.4 are gone.
- It has 63 releases, and `pi-coding-agent` 1.5.1 is built on it.

**Pi `pi-durable` 1.5.1** (MIT):
- It is a separate harness with its own loop (the `pi.generation` task), built on `pi-ai` and `chord`. It does not depend on `pi-agent-core`. The two are alternatives, not layers.
- It is about 24,600 lines of JS. First released 2026-09-19, with 19 releases since, and marked "Experimental. The API changes without notice between releases."
- It provides:
  - commit-before-show storage and crash recovery
  - durable tasks with `sleepUntil` timers that survive restarts
  - child tasks
  - a per-conversation input queue (steer, follow-up, and write entries that skip the model)
  - automatic background compaction
  - `beforeRequest`, `afterRun`, and `beforeTool` hooks
  - extensions made of tools, prompt sections, hooks, and tasks
  - a `watch()` stream for remote clients
  - SQLite, JSONL, IndexedDB, and in-memory storage; SQLite takes a table prefix so it can share a database with the host
- It has no coding defaults: coding tools sit behind a separate `/tools` import, and the prompt is built only from installed sections.
- It has no cron helper, no external-event watchers, no notification inbox, and no approval flow.

**`pi-mcp` 1.5.1** (MIT): a standalone MCP client whose only dependency is `cross-spawn`.

**Mastra `@mastra/core` 1.82.0** (Apache-2.0, except `ee/`):
- About 95 MB unpacked, built on AI SDK providers.
- Observational Memory compresses one thread at a time; the shared resource scope is deprecated. Long-term memory about the user is working memory, a notes block the model edits itself.
- Proactive features: cron schedules (best-effort, a missed run is skipped), signals, signal providers, a notification inbox, background tasks, durable agents, and tool approvals.
- It keeps its own storage and threads.

**Logins:** model access is by API key to providers that use standard formats (OpenAI-compatible or Anthropic Messages). Anthropic prohibits third-party use of Claude subscription logins, so that option is closed for every runtime.

**Bun 1.4.4** loads `node:sqlite` (`DatabaseSync`), which pi-durable's SQLite storage uses through `chord/sqlite/node`. This has not been run end to end.

## Decision

Build the Bot runtime on `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and `@earendil-works/pi-mcp`, all pinned to an exact version. Do not use `pi-agent-core`, `pi-coding-agent`, Mastra, or TanStack AI for the runtime.

- **One app session module** is the only code that imports `pi-durable`. The worker protocol, Service, and clients do not see its types, so an API change touches one place.
- **pi-durable storage** lives in the Service's SQLite database under a `pi_` table prefix. The Service stays the owner of Bots, Threads, and transcripts.
- **Memory is owned by the app**, as specified in [the memory spec](../specs/bot-memory.md). Recall goes in through `beforeRequest`, which changes only that one request. Learning runs as durable tasks started from `afterRun`.
- **Proactive features are owned by the app** and built on durable tasks: recurring check-ins (sleep until the next cron time, then submit), follow-ups and reminders (`sleepUntil`), watchers (a poll, sleep, poll loop), and ask-before-act (`beforeTool` plus an app approval flow). Notification delivery to clients is the app's.
- **Tools come as app extensions**: computer, browser, web, Bot mail, Local Sidecar, plugins, and MCP through `pi-mcp`. The pi-durable coding tools are not installed.
- **Models** come through `pi-ai` with an app secret store in the OS keychain. Users add providers by protocol: OpenAI-compatible or Anthropic Messages, plus a base URL and key. Built-in `pi-ai` providers are also available. No provider gets special-case code.

## Reasons

1. **Proactive work.** pi-durable covers the hard parts: durable timers, child tasks, crash recovery, the input queue, and compaction. What it lacks (cron, watchers, inbox, approvals) are thin layers over its tasks. Its timers are stronger than Mastra's best-effort schedules.
2. **Memory.** No option meets the accuracy rules. Pi has no memory at all; Mastra's cross-thread memory is the self-edited notes pattern that caused the Hermes failures. pi-durable gives the two hooks the app's memory needs: a per-request context change, and durable work after each run.
3. **The Service keeps ownership.** Shared SQLite with a prefix, plus `watch()`, fit one Bot service with desktop and mobile clients. Mastra brings a second storage and thread model.
4. **Logins.** `pi-ai` speaks the standard provider protocols, so no provider needs its own code.
5. **Weight and licence.** pi-durable is MIT and a fraction of Mastra's size.

## Alternatives considered

### pi-ai and pi-agent-core
- Pros: small, stable, and used by Pi's own product.
- Cons: storage, crash recovery, compaction, timers, tasks, and the input queue would all be app code.
- Rejected: it rebuilds what pi-durable provides, for a product built around background and proactive work.

### TanStack AI (`@tanstack/ai` 1.4.0, MIT)
- Pros:
  - stable 1.x from an established team
  - approvals that survive restarts (interrupts), compaction, Skills, an MCP client with OAuth, and an OpenAI-compatible adapter
  - client libraries and the AG-UI protocol
  - resumable streams, so a reply keeps running and clients rejoin after a disconnect or reload
- Cons:
  - no scheduler, timers, or saved tasks
  - a plain `chat()` run is not resumed after the server process dies; it is ended as aborted. Only runs in `@tanstack/ai-sandbox` can be taken over, which needs shared run, sandbox, and lock stores.
  - storage is interfaces only, so we would write the SQLite stores
- Rejected on 2026-11-10 by the user: Bots acting on their own and crash recovery are the core of the product, and pi-durable provides both. Its client libraries remain worth considering for the desktop and mobile clients.

### Mastra
- Pros: the most built-in proactive features (cron, signal providers, notification inbox, approvals) and a large ecosystem.
- Cons: its memory model conflicts with the accuracy rules. It brings its own storage and threads. It is heavy and changes fast.
- Rejected: the parts we would rely on are covered by pi-durable, and its storage model competes with the Service.

## Prototype

Run before any implementation tickets, to find integration problems early. It stays outside product code and uses real keys with a small model allowance. It passes when one script does all of these:

1. Runs a model through a standard `pi-ai` provider (for example `opencode-go`) under Bun, with pi-durable SQLite storage in a copy of the Service database under a `pi_` prefix.
2. Adds a recall line through `beforeRequest`, and shows it reached the model but is absent from stored entries.
3. Schedules a reminder with `sleepUntil`, kills and restarts the process, and shows the reminder posts into the existing conversation.
4. Loads an existing Thread from current data into a pi-durable conversation, and continues it.
5. Streams a conversation through `watch()` to the web client, including a reconnect.

A failed check is solved within pi-durable, through a workaround in the runtime module, an adapter, or an upstream fix, and the runtime spec is updated to match.

## Consequences

- `.scratch/bot-runtime/spec.md`, which targeted `pi-agent-core` 0.84.4, is replaced by [the runtime spec](../specs/bot-runtime.md).
- [The memory spec](../specs/bot-memory.md) keeps its design. Its recall and learning hooks map to `beforeRequest` and `afterRun`.
- New specs are needed for:
  - proactive Bots: check-ins, follow-ups, watchers, notifications, and ask-before-act
  - the restructure into one Bot service with desktop and mobile clients, cross-platform computer use, and the rename
- Each pi-durable upgrade is a deliberate change: read the release notes, update the session module, and rerun the prototype checks as tests.

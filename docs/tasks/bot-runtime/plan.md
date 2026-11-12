# Implementation Plan: Bot runtime on pi-durable

Status: approved 2026-11-12. The switch approach is used; new screens follow `apps/web/AGENTS.md`.

Spec: [docs/specs/bot-runtime.md](../../specs/bot-runtime.md) · Decision: [ADR 0016](../../adr/0016-build-bots-on-pi-durable.md) · Prototype: `prototypes/bot-runtime/` on branch `proto/bot-runtime` · Tasks: [todo.md](todo.md)

## Overview

Replace the Pi agent worker (`workers/pi`, `pi-coding-agent` 0.84.4, and the agent protocol) with an in-process runtime built on `pi-ai`, `pi-durable`, and `pi-mcp` 1.5.2. The runtime lives in `apps/daemon/src/modules/runtime/` and is the only code that imports pi-durable. Existing Bots, Threads, and transcripts carry over, and clients see the same Messages and events as today.

## What exists today

- `TurnService` (`modules/turns/turns.ts`, about 1,000 lines) starts Turns by sending agent-protocol commands to the Pi worker through the Supervisor, and turns worker events into Messages and events.
- `AgentsRegistry` tracks Agent readiness and capabilities. Every Bot has an `agent_id`.
- Tools run in the worker and call back to the Service over the tool channel: computer, browser, local sidecar, plugins, and Bot mail. MCP runs in the worker through `pi-mcp-adapter`.
- An `approvals` table exists from an earlier schema but has no working flow.
- **Not built yet**, though the spec calls them "unchanged from the previous spec": `web_fetch` and `web_search`, each Bot's private folder, and the workspace cleanup that merges Skills and `.mcp.json`. They are new work here.

## Architecture decisions

- **Cut over behind a switch.** The new runtime is built next to the worker path, and selected by a Service setting (`runtime: "worker" | "durable"`, default `worker`) until the cutover task. Each task then leaves the app working, and the old path can be compared with the new until it is removed.
- **TurnService keeps its public API.** Routes, mailbox, and clients keep calling `TurnService`. Inside, it calls either the worker path or `BotRuntime`. The cutover task removes the worker branch.
- **Tools call Service modules directly.** In-process extensions call `ComputerBroker`, `SidecarBroker`, `PluginsService`, and `MailboxService` without the tool channel. The computer worker and sidecar protocols stay.
- **One approval flow.** It reuses the `approvals` table with a forward migration, and pauses tools as durable tool tasks as the spec describes.
- **The credential store** is a new Service table, protected like device tokens, and used for model keys and MCP OAuth.
- **Migrations** follow `persistence/db.ts` conventions: forward-only, named, and covered by `bot-migrations.test.ts`.

## Dependency graph

```
1 packages + harness + lint ─┬─ 2 credentials + models ─┬─ 3 first Turn (switch)
                             │                          │     ├─ 4 steer/abort/failures
                             │                          │     ├─ 5 restart + resume
                             │                          │     └─ 6 compaction
                             │                          │
                             │                          └─ 16 provider import + Settings UI
3 ── 7 prompt + Skills + private folders ── 8 files/shell + allowed folders ── 9 approvals (server) ── 10 approvals (UI)
3 ── 11 computer + browser    3 ── 12 mail + sidecar + plugins
3 ── 13 MCP tool ── 14 MCP OAuth + token import
3 ── 15 web tools             7 ── 17 workspace cleanup
3 ── 18 session migration
all of 4–18 ── 19 cutover + deletion ── 20 remove worker + Agent UI ── 21 real scenarios + docs
```

## Task list

### Phase 1: Foundation
- [ ] Task 1: Pinned packages, runtime module skeleton, Harness lifecycle, and boundary lint
- [ ] Task 2: Credential store and model providers
- [ ] Task 3: First Turn on the new runtime, behind the switch

### Checkpoint A
- [ ] `bun run typecheck`, `bun run lint:boundaries`, `bun test apps/daemon` pass
- [ ] With the switch on, a Direct Thread streams a reply from a fake model in the dev app
- [ ] Review with the human

### Phase 2: Turn behavior
- [ ] Task 4: Steering, follow-ups, abort, failed runs, and `maxTurns`
- [ ] Task 5: Restart, `resume()`, and shutdown
- [ ] Task 6: Compaction with author labels

### Checkpoint B
- [ ] Existing Thread and lifecycle integration tests pass with the switch on
- [ ] Killing the Service mid-reply resumes or visibly fails the reply

### Phase 3: Prompt and tools
- [ ] Task 7: App prompt sections, Skills list, and private folders
- [ ] Task 8: Files and shell tools with allowed folders
- [ ] Task 9: Approval flow on the Service
- [ ] Task 10: Approval UI in the web client
- [ ] Task 11: Computer and browser tools in process
- [ ] Task 12: Bot mail, Local Sidecar, and plugin tools in process

### Checkpoint C
- [ ] Agent computer, browser, mailbox, and sidecar integration tests pass with the switch on
- [ ] A write outside the allowed folders asks, survives a restart, and writes once
- [ ] Review with the human

### Phase 4: MCP, web, and workspace
- [ ] Task 13: MCP through `pi-mcp`
- [ ] Task 14: MCP OAuth sign-in and token import
- [ ] Task 15: `web_fetch` and `web_search`
- [ ] Task 16: Provider import, Settings providers screen, and per-Bot model
- [ ] Task 17: Workspace cleanup

### Checkpoint D
- [ ] Every tool in the spec's tools table works with the switch on
- [ ] Settings can add an OpenAI-compatible provider and a built-in `pi-ai` provider, and each completes a Turn

### Phase 5: Migration and cutover
- [ ] Task 18: Old session migration on a Thread's first Turn
- [ ] Task 19: Cutover and deletion
- [ ] Task 20: Remove the Pi worker, agent protocol, and Agent UI
- [ ] Task 21: Real scenarios, end-to-end tests, and docs

### Checkpoint E: Complete
- [ ] Every spec success criterion is met
- [ ] `bun run build`, `bun test`, and `bun run test:e2e` pass
- [ ] Review with the human before merging

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| pi-durable API changes between releases | High | Pin exactly; one importer; prototype checks become tests in Task 5 and 9; upgrades are their own task |
| A hang in Service JavaScript freezes everything now that the worker is gone | High | Time limits and abort on every tool; shell, computer, browser, and MCP stdio in child processes; a test per extension that abort works |
| Approval tasks use pi-durable restart retries | Medium | Clean shutdown uses none; the limit and the behavior are tested in Task 9 |
| Transcript order differs from today's (ADR 0007's guarantee) | High | Task 3 compares Messages from the same fake run on both paths |
| Compaction loses authors | Medium | Task 6 test on each default model before launch; structured digest as fallback |
| Session migration loses context | Medium | Native mapping, labeled-text fallback, transcript seed as last resort, each tested with real files |
| Large TurnService change | Medium | The switch keeps the old path until Task 19; Tasks 3–5 add the new path beside it |
| OAuth token import fails | Low | Signing in again is accepted |

## Parallel work

After Task 3, Tasks 4–6, 7, 11, 12, 13, 15, and 18 touch separate files and can run in parallel. Tasks 8 → 9 → 10, 13 → 14, and 19 → 20 → 21 are sequential. Migrations (Tasks 2, 9, 16, 19) must land one at a time.

## Open questions

- Is a temporary Service setting the right switch, or should the cutover happen in one step on a branch?
- Should the Settings providers screen (Task 16) and the approval UI (Task 10) follow a design pass first? Both are new screens.

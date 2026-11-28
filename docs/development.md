# Development workflow

Start with the [project instructions](../AGENTS.md). Locate the affected source and tests using the [code map](README.md#code-map). For desktop frontend changes, follow the [frontend instructions](../apps/omarchy-bot/AGENTS.md).

## Workflow selection

Choose the skill that matches the task and read its `SKILL.md`. Reuse accepted specifications and decisions. For non-trivial work, state assumptions and acceptance criteria and resolve open questions before implementation.

| Task | Skill |
| --- | --- |
| Clarify a design against the codebase | [grill-with-docs](../.agents/skills/grill-with-docs/SKILL.md) |
| Publish a specification from a discussion | [to-spec](../.agents/skills/to-spec/SKILL.md) |
| Split a plan into tickets and record their dependencies | [to-tickets](../.agents/skills/to-tickets/SKILL.md) |
| Evaluate incoming GitHub issues | [triage](../.agents/skills/triage/SKILL.md) |
| Implement work described by a spec or ticket | [implement](../.agents/skills/implement/SKILL.md) |
| Deliver a spec and its linked tickets on one integration branch | [implement-spec](../.agents/skills/implement-spec/SKILL.md) |
| Diagnose a bug or performance regression | [diagnosing-bugs](../.agents/skills/diagnosing-bugs/SKILL.md) |
| Develop a behavior test-first | [tdd](../.agents/skills/tdd/SKILL.md) |
| Review changes against the project standards and originating spec | [code-review](../.agents/skills/code-review/SKILL.md) |

For Rust implementation, porting, and review, use [rust-best-practices](../.agents/skills/rust-best-practices/SKILL.md), [rust-port](../.agents/skills/rust-port/SKILL.md), and [rust-review](../.agents/skills/rust-review/SKILL.md) respectively.

## Project artifacts

`/to-spec` publishes the specification as a GitHub issue in `x-metheus/omarchy-bot`. `/to-tickets` takes a plan, spec, or discussion and publishes one issue per approved ticket. Each ticket carries its acceptance criteria and blocking dependencies. When the source is a spec issue, the tickets become its sub-issues. See the [issue tracker guide](agents/issue-tracker.md) and [triage label mapping](agents/triage-labels.md).

| Repository reference | Location | Contents |
| --- | --- | --- |
| Feature specification, when maintained in the repo | `docs/specs/<feature>.md` | Scope, decisions, and acceptance criteria. Link the file from its spec issue. |
| Quality requirements | `docs/CONSTRAINTS.md`, when present | Agreed requirements and the commands that check them |
| Domain terminology and architecture decisions | Root `GLOSSARY.md` when present and shared ADRs, as described in the [domain guide](agents/domain.md) | Agreed terms, design decisions, and their rationale |

## Stack and verification

- TypeScript workspaces use ES modules and the exact Bun version pinned in `engines.bun`. [Root manifest](../package.json)
- The desktop app uses React, Vite, Astryx, and Tauri. For desktop interactions, native capabilities, and end-to-end flows, run `bun run tauri dev` and verify the behavior in the running App window on the current platform. The App window exercises the native Tauri bridge and platform WebView. [App manifest](../apps/omarchy-bot/package.json)
- The standalone Agent Daemon runs Rig on Rust 1.97.1. Its integration tests use temporary databases and scripted providers. [Agent Daemon guide](../apps/agent-daemon/README.md#checks)

Run these commands from the repository root. Consult the affected workspace’s `package.json` for additional checks.

| Command | Purpose |
| --- | --- |
| `bun install --frozen-lockfile` | Install locked dependencies |
| `bun run tauri dev` | Run the native Tauri development window |
| `bun run typecheck` | Check TypeScript types |
| `bun test <path>` / `bun test` | Run focused tests / the Bun suite |


### Desktop project layout

`apps/omarchy-bot` contains the Bun manifest, Vite config and frontend sources alongside `src-tauri`. The project is based on the official Bun, React TypeScript, Tauri 2 scaffold. To reproduce the starting scaffold in an empty directory, run `bunx create-tauri-app@4.7.5 omarchy-bot --manager bun --template react-ts --tauri-version 2 --identifier com.omarchy.bot --yes`. See the [Tauri project guide](https://v2.tauri.app/start/create-project/) and [Vite integration guide](https://v2.tauri.app/start/frontend/vite/).

Install the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) and run `bun install --frozen-lockfile`. Start daily UI checks from `apps/omarchy-bot` or the repository root with `bun run tauri dev`. Tauri starts Vite on `http://127.0.0.1:7322` and incrementally compiles the native debug target. A clean checkout can start without a prebuilt frontend or staged binaries. Connect to a running Agent Daemon, or set `OMARCHY_BOT_AGENT_DAEMON_BIN` to a daemon executable to check managed startup. [Standalone daemon setup](../apps/agent-daemon/README.md#headless-startup)

The legacy `apps/site` workspace retains its explicit `site:dev` and `site:build` commands.

Implement and verify one increment at a time. For a behavior fix, start with a failing regression test. For desktop UI changes, verify the affected behavior in the Tauri development window. For documentation, check links, paths, commands, and the diff. Preserve existing checks and report the verification commands, their results, and any unresolved blockers.

### Desktop releases

Run App production builds, packaging, and cross-platform package checks only for explicit release tasks.

| Command | Purpose |
| --- | --- |
| `bun run build` | Build the production desktop frontend |
| `bash scripts/build-linux-app.sh` | Package the desktop app and standalone daemon on Linux |

The platform release scripts stage the daemon and verified Recall model, then invoke `tauri build` with the release configuration. Release smoke checks use packaged builds on Linux (WebKitGTK), macOS (WKWebView), and Windows (WebView2). See the [Linux](../scripts/linux-app/README.md), [macOS](../scripts/macos-app/README.md), and [Windows](../scripts/windows-app/README.md) guides and the [release workflow](../.github/workflows/app-release.yml).

## Skill resources and maintenance

The engineering workflows come from `mattpocock/skills` and the Rust workflows from `morganlinton/BeautifulRust`. Each skill has a `SKILL.md` and any supporting files in the [installed skills directory](../.agents/skills/). The source repository, commit, upstream path, and content hash are recorded in [skills-lock.json](../skills-lock.json).

When refreshing skills, update the installed directories and lockfile together through the installer. Verify that the skill links in this guide resolve after the update. Keep the repository’s tracker, triage, and domain conventions in [docs/agents/](agents/).

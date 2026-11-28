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

- The root Cargo workspace contains the standalone Agent Daemon and the Tauri native crate. Both use the root lockfile and toolchain. The daemon integration tests use temporary databases and scripted providers. [Workspace manifest](../Cargo.toml) · [Agent Daemon guide](../apps/agent-daemon/README.md#checks)
- mise pins the development tools. Desktop frontend, site, and release tooling use their own Bun manifests and lockfiles. [mise configuration](../mise.toml)

Run these commands from the repository root. With mise activated in your shell, run Cargo and Bun directly. Otherwise prefix them with `mise exec --`.

| Command | Purpose |
| --- | --- |
| `mise install` | Install the pinned Rust and Bun versions |
| `cargo test --workspace --locked` | Test both native crates |
| `cargo test -p omarchy-agent-daemon --locked --test conversation` | Run the daemon protocol suite |
| `bun --cwd=apps/omarchy-bot install --frozen-lockfile` | Install the desktop's locked dependencies |
| `mise run daemon` | Build and start the standalone Agent Daemon |
| `mise run dev` | Open the native Tauri development window |
| `bun --cwd=apps/omarchy-bot run typecheck` | Check desktop TypeScript types |
| `bun --cwd=apps/omarchy-bot run test` | Run the desktop's Bun tests |


### Standalone daemon

`mise run daemon` starts the daemon in the foreground and prints its loopback address. It runs from `apps/agent-daemon` and uses the root Cargo lockfile. For pairing and provider Settings, set `OMARCHY_AGENT_DB`, `OMARCHY_AGENT_MASTER_KEY_FILE`, and `OMARCHY_AGENT_SETTINGS_TOKEN_FILE` as shown in the standalone setup. Then open the desktop in a second terminal with `mise run dev`. [Standalone daemon setup](../apps/agent-daemon/README.md#headless-startup)

### Desktop project layout

`apps/omarchy-bot` contains the Bun manifest, Vite config and frontend sources alongside `src-tauri`. The project is based on the official Bun, React TypeScript, Tauri 2 scaffold. To reproduce the starting scaffold in an empty directory, run `bunx create-tauri-app@4.7.5 omarchy-bot --manager bun --template react-ts --tauri-version 2 --identifier com.omarchy.bot --yes`. See the [Tauri project guide](https://v2.tauri.app/start/create-project/) and [Vite integration guide](https://v2.tauri.app/start/frontend/vite/).

Install the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/). Run `mise run dev` from the repository root or `bun run tauri dev` from `apps/omarchy-bot`. Tauri starts Vite on `http://127.0.0.1:7322` and compiles the debug target in the Cargo workspace. A clean checkout can start without a prebuilt frontend or staged binaries. For interactions and native capabilities, exercise the behavior in the App window on your current platform. Connect to a running Agent Daemon, or set `OMARCHY_BOT_AGENT_DAEMON_BIN` to a daemon executable to check managed startup. [Standalone daemon setup](../apps/agent-daemon/README.md#headless-startup)

For site development, install its dependencies and run `bun run dev` inside `apps/site`.

Implement and verify one increment at a time. For a behavior fix, start with a failing regression test. For desktop UI changes, verify the affected behavior in the Tauri development window. For documentation, check links, paths, commands, and the diff. Preserve existing checks and report the verification commands, their results, and any unresolved blockers.

### Desktop releases

Run App production builds, packaging, and cross-platform package checks only for explicit release tasks.

| Command | Purpose |
| --- | --- |
| `bun --cwd=apps/omarchy-bot run build:frontend` | Build the production desktop frontend |
| `bash tools/release/build-linux-app.sh` | Package the desktop app and standalone daemon on Linux |

The platform release scripts in `tools/release` stage the daemon and verified Recall model, then invoke `tauri build` with the release configuration. See the [Linux](../tools/release/linux-app/README.md), [macOS](../tools/release/macos-app/README.md), and [Windows](../tools/release/windows-app/README.md) guides and the [release workflow](../.github/workflows/app-release.yml).

## Skill resources and maintenance

The engineering workflows come from `mattpocock/skills` and the Rust workflows from `morganlinton/BeautifulRust`. Each skill has a `SKILL.md` and any supporting files in the [installed skills directory](../.agents/skills/). The source repository, commit, upstream path, and content hash are recorded in [skills-lock.json](../skills-lock.json).

When refreshing skills, update the installed directories and lockfile together through the installer. Verify that the skill links in this guide resolve after the update. Keep the repository’s tracker, triage, and domain conventions in [docs/agents/](agents/).

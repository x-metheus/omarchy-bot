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

- The TypeScript workspaces use ES modules and the exact Bun version pinned in `engines.bun`. When upgrading Bun, rerun the secret-store tests because the runtime uses the experimental `Bun.secrets` API. [Root manifest](../package.json) · [Secret-store tests](../apps/daemon/src/modules/runtime/bunSecrets.test.ts)
- The desktop app keeps React, Vite, Astryx, and Tauri in one project. The [app manifest](../apps/omarchy-bot/package.json) pins the Tauri CLI and declares frontend dependencies. The Rust Local Sidecar builds separately. Verify desktop interactions in the running Tauri app using the platform WebView. Release smoke uses packaged builds on Linux (WebKitGTK), macOS (WKWebView), and Windows (WebView2). [Linux smoke](../scripts/linux-app/README.md) · [macOS smoke](../scripts/macos-app/README.md) · [Windows smoke](../scripts/windows-app/README.md)

Run these commands from the repository root. Consult the affected workspace’s `package.json` for additional checks.

| Command | Purpose |
| --- | --- |
| `bun install --frozen-lockfile` | Install locked dependencies |
| `bun run tauri dev` | Run the Tauri development window for daily Agent Daemon UI checks |
| `bash scripts/build-linux-app.sh` | Build the packaged desktop and standalone daemon on Linux |
| `OMARCHY_BOT_DEV=1 bun run dev` | Run the legacy Service development harness |
| `bun run typecheck` | Check TypeScript types |
| `bun run lint:boundaries` | Check package dependency boundaries |
| `bun run build` | Check boundaries and build the Service helper and desktop frontend |
| `bun test <path>` / `bun test` | Run focused tests / the Bun suite |


### Desktop project layout

`apps/omarchy-bot` contains the Bun manifest, Vite config and frontend sources alongside `src-tauri`. The project is based on the official Bun, React TypeScript, Tauri 2 scaffold. To reproduce the starting scaffold in an empty directory, run `bunx create-tauri-app@4.7.5 omarchy-bot --manager bun --template react-ts --tauri-version 2 --identifier com.omarchy.bot --yes`. See the [Tauri project guide](https://v2.tauri.app/start/create-project/) and [Vite integration guide](https://v2.tauri.app/start/frontend/vite/).

Install the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) and run `bun install --frozen-lockfile`. Run `bun run tauri dev` from `apps/omarchy-bot` or the repository root. Tauri starts Vite on `http://127.0.0.1:7322` and incrementally compiles the Rust debug target. The command works without a prebuilt frontend or staged binaries. Connect to a running Agent Daemon for normal UI checks. For managed startup, set `OMARCHY_BOT_AGENT_DAEMON_BIN` to the absolute path of a daemon executable from the [standalone setup](../apps/agent-daemon/README.md).

The platform release scripts stage the daemon and verified Recall model, then invoke `tauri build` with the release configuration. See [Linux](../scripts/linux-app/README.md), [macOS](../scripts/macos-app/README.md), and [Windows](../scripts/windows-app/README.md) for packaging and native smoke commands. To exercise the legacy Local Sidecar itself, stage it with `bun scripts/build-sidecar.ts` and add `--config '{"bundle":{"externalBin":["binaries/omarchy-bot-sidecar"]}}'` to the Tauri command.

The legacy `apps/site` workspace retains its explicit `site:dev` and `site:build` commands.

Implement and verify one increment at a time. For a behavior fix, start with a failing regression test. For desktop UI changes, verify the affected behavior in the Tauri development window. For documentation, check links, paths, commands, and the diff. Preserve existing checks and report the verification commands, their results, and any unresolved blockers.

## Skill resources and maintenance

The engineering workflows come from `mattpocock/skills` and the Rust workflows from `morganlinton/BeautifulRust`. Each skill has a `SKILL.md` and any supporting files in the [installed skills directory](../.agents/skills/). The source repository, commit, upstream path, and content hash are recorded in [skills-lock.json](../skills-lock.json).

When refreshing skills, update the installed directories and lockfile together through the installer. Verify that the skill links in this guide resolve after the update. Keep the repository’s tracker, triage, and domain conventions in [docs/agents/](agents/).

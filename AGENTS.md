# Omarchy Bot agent instructions

## Conversational Style

- Use concise, direct technical language. Define unfamiliar terms. For non-trivial designs or bugs, state the problem, give a concrete example or short trace, and explain why the solution is needed.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to a specific assessment from the user, state whether you agree before describing any changes.

## Code Quality

- When a Matt Pocock skill applies to the task, follow its `SKILL.md` in the [installed skills directory](.agents/skills/).
- When writing Rust code, follow [rust-best-practices](.agents/skills/rust-best-practices/SKILL.md).
- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Before recommending a fix design, check how sibling implementations (other adapters, providers, commands) handle the same concern, and follow that pattern. If you deviate, say why.
- Diagnose dependency-related type errors against the locked version. Upgrade when the task requires a newer API or fix, and verify the affected callers.

- Preserve behavior that existing callers rely on. For an approved breaking change, follow the agreed scope and update affected callers.
- Before adding or changing Rig integration, read the relevant versioned [API docs](https://docs.rs/) and [upstream source](https://github.com/0xPlaygrounds/rig/tags) for the version in `Cargo.lock`. Use the target version when adding or upgrading a Rig dependency.

## Tests

- Add a test when a requirement or regression needs coverage. Prefer extending an existing test with one representative input per behavior. Use unit tests for isolated behavior and integration tests for behavior that spans components.

## Agent skills

### Issue tracker

Publish and fetch tickets and specifications in GitHub Issues for `x-metheus/omarchy-bot`. See the [issue tracker instructions](docs/agents/issue-tracker.md).

### Triage labels

Use the five default GitHub triage labels when classifying an issue. See the [triage label mapping](docs/agents/triage-labels.md).

### Domain docs

Use the shared root glossary and relevant architecture decisions when exploring the codebase. See the [domain documentation instructions](docs/agents/domain.md).

## Project workflow

- Inspect the working tree and preserve edits already in progress. Locate the relevant source and tests using the [project code map](docs/README.md#code-map).
- Before implementation, read the relevant GitHub spec or ticket and any linked specification in `docs/specs/`. Consult `docs/CONSTRAINTS.md` when present. Confirm any unresolved requirements that affect the work.
- For frontend changes in `apps/omarchy-bot/`, follow the [frontend instructions](apps/omarchy-bot/AGENTS.md).
- Run focused tests and applicable Bun or Cargo checks for the affected code. For documentation, check links, paths, commands, and the diff. Report results and blockers.
- To verify desktop interactions or native capabilities, including end-to-end flows, run `bun run tauri dev` from the repository root and exercise the behavior in the App window on the current platform. Report any blocker that prevents verification in the Tauri window.
- Run App production builds, packaging, and cross-platform package checks only for explicit release tasks. See the [development guide](docs/development.md#stack-and-verification).
- Commit, push, merge, or deploy when the user’s request or an authorized project workflow calls for it.

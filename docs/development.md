# Development workflow

Omarchy Bot uses [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) for its development process. Start each task with [using-agent-skills](../.agents/skills/using-agent-skills/SKILL.md), then load the full instructions for the workflows the task needs. Installing the collection does not mean running every skill for every change.

[The documentation index](README.md) routes work to code and tests. [AGENTS.md](../AGENTS.md) is the entry point for coding agents; instructions in an affected directory also apply. Web UI work follows [apps/web/AGENTS.md](../apps/web/AGENTS.md).

## Workflow selection

| Task | Workflow |
| --- | --- |
| Unclear intent or an early idea | `interview-me`; use `idea-refine` when alternatives need exploration |
| New feature or significant behavior change | `spec-driven-development` → `planning-and-task-breakdown` |
| Establish or change quality standards | `constraint-driven-development`; read `docs/CONSTRAINTS.md` before writing code when it exists |
| Implement an accepted task | `context-engineering` → `incremental-implementation` + `test-driven-development`; use `source-driven-development` for framework and library decisions |
| Diagnose a failure | `debugging-and-error-recovery` → `test-driven-development` → `code-review-and-quality` |
| Review or simplify existing code | `code-review-and-quality`; use `code-simplification` for behavior-preserving cleanup and `performance-optimization` for measured performance work |
| Record and deliver a change | `documentation-and-adrs` + `git-workflow-and-versioning`; use `shipping-and-launch` for a production launch |

Add specialist workflows when the task requires them:

- UI: `frontend-ui-engineering` and `browser-testing-with-devtools`.
- APIs and module contracts: `api-and-interface-design`.
- Untrusted input, authentication, storage, dependencies, or integrations: `security-and-hardening`.
- Production diagnostics: `observability-and-instrumentation`.
- CI and deployment automation: `ci-cd-and-automation`.
- Removal, replacement, or data migration: `deprecation-and-migration`.
- High-stakes or unfamiliar decisions: `doubt-driven-development`.

State assumptions and acceptance criteria before non-trivial work. Reuse accepted specifications and decisions, and resolve material ambiguity before dependent work. Follow the selected skills' verification and explicit approval gates. For a new specification, `spec-driven-development` requires saving the spec and obtaining approval before planning or implementation. User instructions take precedence; do not ask again for authorization already given for the same scope.

Implement one verifiable increment at a time. After implementation, review with `code-review-and-quality`, apply `code-simplification` when needed, and update documentation before handoff. Bug fixes enter through debugging; documentation edits use the documentation workflow without starting a new feature lifecycle.

## Project artifacts

Project documentation belongs in `docs/`. Use these locations when following the skills; they replace upstream example defaults such as root `SPEC.md`, `tasks/plan.md`, `tasks/todo.md`, and `CONSTRAINTS.md`.

| Artifact | Project location | Contents |
| --- | --- | --- |
| Feature specification | `docs/specs/<feature>.md` | Scope, requirements, decisions, acceptance criteria, and approval status |
| Implementation plan | `docs/tasks/<feature>/plan.md` | Link to the specification, implementation order, dependencies, risks, and verification checkpoints |
| Task checklist | `docs/tasks/<feature>/todo.md` | Link to the plan, acceptance and verification steps, dependencies, and current progress |
| Quality requirements | `docs/CONSTRAINTS.md` | Agreed requirements and the commands that check them |
| Architecture decisions | `docs/adr/` | Decisions that need a lasting rationale, following `documentation-and-adrs` and the established naming convention |

Use the same feature name for its specification, plan, and checklist. Create artifacts when the selected workflow calls for them; do not generate empty documents for every task. Preserve accepted specifications and unfinished plans. A session-only task list does not replace a workflow's durable task checklist. Check relevant existing notes and code before recording new decisions, and do not infer approval from a draft.

Keep workflow adaptations here or in the applicable agent instructions. Keep the installed upstream skill files intact; apply the project path mapping when they refer to default artifact names.

## Stack and verification

- Runtime and package manager: Bun, pinned exactly to 1.4.5 (`engines` in [package.json](../package.json), CI, and packaging), TypeScript, ES modules, Bun workspaces. The secret store uses Bun's experimental `Bun.secrets`, so a Bun upgrade is deliberate and reruns the secret-store tests.
- Web UI: React 19, Vite 7, Astryx 0.5.2; preserve the local Astryx rules.
- Native application and sidecar work includes Rust and Tauri; browser checks alone do not verify a packaged WebView.

Discover the affected workspace's scripts before running commands. Root commands are defined in [package.json](../package.json):

| Command | Purpose |
| --- | --- |
| `bun install --frozen-lockfile` | Install locked dependencies |
| `OMARCHY_BOT_DEV=1 bun run dev` | Run the Service and web development harness |
| `bun run typecheck` | Check TypeScript types |
| `bun run lint:boundaries` | Check package dependency boundaries |
| `bun run build` | Check boundaries and build workspaces |
| `bun test <path>` / `bun test` | Run focused tests / the Bun suite |
| `bun run test:e2e` | Run the Playwright suite with its configured prerequisites |

Choose checks that exercise the change and satisfy the selected skill. Use a failing regression test for behavior fixes, verify browser behavior for UI changes, and apply the [Definition of Done](../.agents/references/definition-of-done.md) before declaring work complete. Documentation-only changes need link, path, command, and diff checks; run application checks when the change can affect application behavior.

Preserve existing checks. Do not weaken requirements, skip failing tests, or add suppressions to make a change pass. Do not invent numerical budgets or claim a check is enforced without evidence. Record verification commands, results, and unresolved blockers honestly. Finish with the changed behavior or process, the verification evidence, and any remaining limits.

## Skill resources and maintenance

`.agents/` contains the installed skills and their supporting resources. These are dependencies of the workflow; project specifications, plans, and documentation live in `docs/`.

- `.agents/skills/`: the 25 workflows installed from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills). [skills-lock.json](../skills-lock.json) records their source paths and installer hashes.
- `.agents/references/`: the seven shared checklists, copied without modification from upstream commit [`301b02b12bff98e4688e6984af6556802322bbde`](https://github.com/addyosmani/agent-skills/tree/301b02b12bff98e4688e6984af6556802322bbde/references).
- [.agents/LICENSE](../.agents/LICENSE): the upstream MIT license for the imported resources.

The shared checklists stay at `.agents/references/` because skills refer to them as `../../references/<name>.md` from their own directories. Keep them alongside the skills so those relative paths resolve.

When updating the collection:

1. Review upstream workflow changes and preserve project-specific rules and unfinished feature artifacts.
2. Update the skills through the installer and keep `skills-lock.json` consistent with the skills actually present in `.agents/skills/`.
3. Review and copy the corresponding upstream shared references and license; record their source commit here. Updating skill directories alone may leave the shared checklists unchanged.
4. Check that the expected workflows are discoverable, shared-reference paths resolve, project commands match `package.json`, and project artifact paths still apply. Review the diff before using the updated workflow.

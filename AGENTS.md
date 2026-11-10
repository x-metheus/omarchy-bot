# Omarchy Bot agent instructions

This project uses [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) as its default development workflow.

## Start each task

1. Read [using-agent-skills](.agents/skills/using-agent-skills/SKILL.md), select the applicable workflows, and load their full instructions as needed. State which workflows you are using.
2. Follow [the project development workflow](docs/development.md). Use [the documentation index and code map](docs/README.md) to find relevant source and tests.
3. Inspect the working tree and preserve existing edits and deletions. Read the affected code, tests, and directory instructions. Web UI work also follows [apps/web/AGENTS.md](apps/web/AGENTS.md).
4. State assumptions and acceptance criteria before non-trivial work. Reuse accepted specifications and decisions, and resolve material ambiguity before dependent work.
5. Follow the selected skills' verification and explicit approval gates. User instructions take precedence; do not ask again for authorization already given for the same scope.

## Project documentation and completion

Project documentation lives in `docs/`. The [project artifact locations](docs/development.md#project-artifacts) replace upstream default paths for specifications, plans, task checklists, and quality requirements. Read `docs/CONSTRAINTS.md` before writing code when it exists. Keep installed skill files and their shared resources in `.agents/` intact.

Implement and verify small increments, review the result, and update the relevant documentation. Use the project's [verification commands](docs/development.md#stack-and-verification) and the [Definition of Done](.agents/references/definition-of-done.md). Do not weaken checks or hide failures; report verification evidence and remaining blockers honestly.

Keep changes focused and preserve other tasks' work. Skills describe the process; they do not grant permission to delegate work, change external systems, or publish changes. Commit, push, merge, or deploy when the user's request or an established authorized workflow includes that action.

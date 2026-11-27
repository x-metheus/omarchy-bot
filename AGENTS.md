# Omarchy Bot agent instructions

When a Matt Pocock skill applies to the task, follow its `SKILL.md` in the [installed skills directory](.agents/skills/).

## Agent skills

### Issue tracker

Publish and fetch tickets and specifications in GitHub Issues for `x-metheus/omarchy-bot`. See the [issue tracker instructions](docs/agents/issue-tracker.md).

### Triage labels

Use the five default GitHub triage labels when classifying an issue. See the [triage label mapping](docs/agents/triage-labels.md).

### Domain docs

Use the shared root glossary and relevant architecture decisions when exploring the codebase. See the [domain documentation instructions](docs/agents/domain.md).

## Project workflow

- Inspect the working tree and preserve edits already in progress. Locate the relevant source and tests using the [project code map](docs/README.md#code-map).
- Before implementation, consult the feature’s accepted specification in `docs/specs/`, its plan and checklist in `docs/tasks/`, and `docs/CONSTRAINTS.md` when present. Confirm any unresolved requirements that affect the work.
- For changes in `apps/web/`, follow the [frontend instructions](apps/web/AGENTS.md).
- Verify each change with focused tests and the applicable [Bun scripts](package.json). For documentation, check links, paths, commands, and the diff. Report the results and any blockers.
- Commit, push, merge, or deploy when the user’s request or an authorized project workflow calls for it.

# AGENTS.md

## Agent skills

### Issue tracker

Issues and specs are tracked as local Markdown under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical labels without overrides. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a multi-context layout routed by `CONTEXT-MAP.md`. See `docs/agents/domain.md`.

## Host safety

Treat the host OS and graphical session as immutable during repository work.

- Resolve missing system dependencies with existing binaries, repository-managed dependencies, or temporary portable artifacts. If none is available, stop that scenario and report the missing prerequisite.
- NEVER invoke host package managers or system/global update flows (`pacman`, AUR helpers, Omarchy updates, or global `mise` upgrades), or stop/restart the host compositor, Omarchy Shell, bar, or graphical-session services, without explicit user authorization in the current conversation.
- Bot Screen processes MUST use private runtime/profile directories and targeted child-process or transient-unit teardown. Never import, modify, or terminate the host graphical-session environment.

## Worktrees

After a worktree's branch is merged into `main`, clean it up in the same session:

- Confirm the branch is merged (`git merge-base --is-ancestor <branch> main`) and the worktree has no uncommitted changes.
- Remove the worktree (`git worktree remove <path>`), delete the merged local branch (`git branch -d <branch>`), and run `git worktree prune`.
- Close the agent terminal or pane that worked in it, and remove the parent worktrees folder once it is empty.
- Never remove a worktree with unmerged commits or uncommitted changes; report it instead.

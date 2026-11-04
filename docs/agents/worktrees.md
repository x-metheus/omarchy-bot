# Worktrees

After a worktree's branch is merged into `main`, clean it up in the same session:

- Confirm the branch is merged (`git merge-base --is-ancestor <branch> main`) and the worktree has no uncommitted changes.
- Remove the worktree (`git worktree remove <path>`), delete the merged local branch (`git branch -d <branch>`), and run `git worktree prune`.
- Close the agent terminal or pane that worked in it, and remove the parent worktrees folder once it is empty.
- Never remove a worktree with unmerged commits or uncommitted changes; report it instead.

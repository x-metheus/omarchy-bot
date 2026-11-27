# GitHub Issues

Publish tickets and specifications to `x-metheus/omarchy-bot` with `gh`. Before the first issue write in a session, check the target with `gh repo view --json nameWithOwner --jq .nameWithOwner`. If the default points elsewhere, pass `--repo x-metheus/omarchy-bot` to `gh issue` commands.

## Ticket operations

- Publish a ticket or spec with `gh issue create --title "<title>" --body-file <file>`. When the project maintains a spec in `docs/specs/`, include its GitHub file link in the issue.
- Fetch a ticket with `gh issue view <number> --json number,title,body,labels,comments`. List open tickets with `gh issue list --state open --json number,title,labels`. Add `--label <label>` to filter by state label.
- Change state with `gh issue edit <number> --add-label <new>`. Include `--remove-label <old>` when replacing a state. Use the [triage label mapping](triage-labels.md).
- Comment with `gh issue comment <number> --body-file <file>`. To close with an explanation, post the comment first, then run `gh issue close <number>`.

**PRs as a request surface: no.**

## Sub-issues and blockers

- Create a child with `gh issue create --parent <parent>` alongside its title and body, or attach an existing child with `gh issue edit <parent> --add-sub-issue <child>`.
- Record a native dependency with `gh issue create --blocked-by <blocker>` or `gh issue edit <child> --add-blocked-by <blocker>`. Check the open blocker count with `gh api repos/x-metheus/omarchy-bot/issues/<child> --jq .issue_dependencies_summary.blocked_by`.
- For `gh` versions without those flags, fetch the related issue’s numeric database ID with `gh api repos/x-metheus/omarchy-bot/issues/<number> --jq .id`. Use `gh api --method POST repos/x-metheus/omarchy-bot/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` for a child or `gh api --method POST repos/x-metheus/omarchy-bot/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` for a blocker.
- Where GitHub relationships are unavailable, put `Part of #<parent>` at the top of the child and link it in the parent’s task list. Record dependencies with `Blocked by: #<number>, #<number>` at the top of the child. Work can start once every blocker has closed.

## Wayfinding operations

- Keep the `/wayfinder` map in an issue labeled `wayfinder:map` with its Notes, Decisions so far, and Fog sections. Track each decision as a child issue with one type label from `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`. Use `gh label create` if a needed map or type label is missing.
- List the map’s children in order with `gh api --paginate repos/x-metheus/omarchy-bot/issues/<map>/sub_issues`, or follow the map’s task list when it records the children. Take the first open, unassigned child whose blockers are all closed.
- Claim it with `gh issue edit <number> --add-assignee @me` before starting work. To resolve it, comment with the answer, close the child, then add a short decision and a link to the child under Decisions so far in the map.

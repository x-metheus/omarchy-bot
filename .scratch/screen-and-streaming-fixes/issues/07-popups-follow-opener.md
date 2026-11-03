# 07: Pop-ups open on the opener Bot's own Screen

Type: task
Status: open
Blocked by: 04

The user decided on 2026-11-03: a pop-up or new window opened by a page (`window.open`, an OAuth login) belongs to the Bot whose browser opened it, never to whichever Screen has focus.

Today (bug A6): nothing routes windows that appear outside a launch. A pop-up maps on the focused Screen, and that Screen's Browser Tool `#scope` (`browserRuntime.ts` around 229-249) can bind it as its own tab, so one Bot can read and act on another Bot's page. Bug A7: the ambiguous-ownership error tells the Agent to "give the page a unique title", which an Agent cannot do.

Scope (architecture candidate 3 in the review):
- Subscribe to Sway `window::new` events.
- Attribute new pack windows to a Screen via the CDP opener target (`Target.targetCreated` `openerId`) or the launch claim.
- Route them to that Screen's workspace.
- Keep one ownership registry shared by Sway routing and the Browser Tool.
- Replace the title-and-size heuristic described in ADR 0012. This needs an ADR 0012 amendment.
- Fix A7's message.

Needs a design pass with Claude before implementation.

## Comments

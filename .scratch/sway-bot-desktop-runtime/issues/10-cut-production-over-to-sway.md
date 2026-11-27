# 10: Cut production Bot Desktop Sessions over to Sway

**Parent:** [#8](https://github.com/XMethues/omarchy-bot/issues/8)

**What to build:** Perform one explicit production cutover so all new Bot Desktop Sessions use the conformance-approved Sway stack, without silently killing live Cage applications, exposing a runtime choice, or retaining automatic Cage fallback.

**Blocked by:** 09: Prove two-Bot Sway conformance and matched resource cost.

**Status:** resolved

- [x] Production wiring selects Sway exclusively for every newly provisioned Bot Desktop Session.
- [x] No public setting, Bot property, environment selector, or fallback chooses between Cage and Sway.
- [x] The migration detects active Cage sessions and waits for their absence or requires an explicit destructive restart after clear save-work guidance.
- [x] The migration does not claim to move live processes or unsaved in-memory state between compositors.
- [x] Bot, Thread, Native Session, Shared Workspace, and eligible disk-backed plugin-owned application state remain intact.
- [x] First post-cutover graphical demand creates a fresh Sway runtime generation and cannot reuse stale Cage endpoints.
- [x] A Sway startup failure uses the existing unavailable/retry lifecycle and never automatically invokes Cage.
- [x] Production startup, first graphical action, Computer Surface opening, Agent-only use, and deletion are exercised through public behavior after the switch.
- [x] Rollout status distinguishes architecture selection, conformance pass, production cutover, Cage removal, and human acceptance.

## Answer

Production `main()` now constructs `SwayBotScreenRuntimeAdapter` with `PortableSwayRuntimeSupply`. There is no compositor selector and no Cage fallback. A missing `OMARCHY_BOT_SWAY_BIN` reports Screen unavailable through the existing snapshot/state/projection path and never starts Cage.

Live leftover Cage trees are processes whose `XDG_RUNTIME_DIR` is a Bot Screen generation directory that is not a Sway `session.json` tree. Those trees block production start with save-work guidance. `OMARCHY_BOT_DESTROY_LEFTOVER_CAGE=1` tears down only those leftover Cage trees; Sway still starts a new generation. Recovered ready surfaces do not reopen leftover Cage sockets.

Rollout: architecture selection true, conformance pass true, production cutover true, Cage removal false, human acceptance pending.

**Files:** `apps/daemon/src/bootstrap/main.ts`, `apps/daemon/src/modules/computer/swayBotScreenRuntime.ts`, `apps/daemon/src/modules/computer/leftoverCage.ts`, `apps/daemon/src/modules/computer/botDesktopRollout.ts`, `apps/daemon/src/bootstrap/config.ts`, Computer ADR 0009, `.scratch/sway-bot-desktop-runtime/rollout-status.md`, `tests/integration/computer.test.ts`, `tests/integration/bot-screen-sway-cutover.test.ts`. Cage adapter files were not deleted.

**Tests:**
- `missing Sway reports Screen unavailable without falling back to another desktop`
- `live Cage trees block production start unless leftover Cage trees are destroyed`
- `recovered ready surfaces do not reopen leftover Cage sockets and start a new Sway generation`
- `production cutover exercises Computer Surface, Agent-only use, deletion, and rollout status`

**Command:** `bun test tests/integration/computer.test.ts tests/integration/bot-screen-sway-cutover.test.ts tests/integration/bot-screen-config.test.ts`

**Leftover:** Cage adapter, supply, and explicit test fixtures remain until ticket 11. Human Host Session acceptance remains ticket 13. Default `bun test` does not start real Sway.

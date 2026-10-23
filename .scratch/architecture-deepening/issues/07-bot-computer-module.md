# 07: Extract BotComputer from the Sway runtime

**Type:** task
**Status:** claimed
**Blocked by:** 06

**What to build:** Split `swayBotScreenRuntime.ts` (2,135 lines) so the **Bot Computer** (compositor, D-Bus, persistent profile, on-disk state, reattach, generation) is its own module and Bot Screens (output + workspace) attach to it. Internal seams for the expanded-view (WayVNC) lease and RFB bridge are private to the adapter and used by its own tests.

Decisions (settled):
- One generation, owned by `BotComputer`, fences Screens; each Screen records the generation it attached under. Replace the three generations (SQLite `runtime_generation`, `computer.json` `Date.now()`, worker env var).
- Recovery after daemon restart has one owner (today spread over `main.ts`, `BotScreenManager.recover`, `#reattachComputer`, `#reattachSurface`, `#ensureHelpers`).
- Deduplicate the triplicated worker/virtual-input spawn blocks and profile/XDG derivation; one capacity check.
- Delete Cage leftovers: `leftoverCage.ts`, `botDesktopRollout.ts`, unused `OMARCHY_BOT_SCREEN_WEBRTC_PORT` in `tests/integration/helpers/harness.ts:52`.

- [ ] Reattach tests at the BotComputer interface (scripted binaries).
- [ ] No behaviour change visible at the runtime seam.

## Comments

# 07: Extract BotComputer from the Sway runtime

**Type:** task
**Status:** resolved
**Blocked by:** 06

**What to build:** Split `swayBotScreenRuntime.ts` (2,135 lines) so the **Bot Computer** (compositor, D-Bus, persistent profile, on-disk state, reattach, generation) is its own module and Bot Screens (output + workspace) attach to it. Internal seams for the expanded-view (WayVNC) lease and RFB bridge are private to the adapter and used by its own tests.

Decisions (settled):
- One generation, owned by `BotComputer`, fences Screens; each Screen records the generation it attached under. Replace the three generations (SQLite `runtime_generation`, `computer.json` `Date.now()`, worker env var).
- Recovery after daemon restart has one owner (today spread over `main.ts`, `BotScreenManager.recover`, `#reattachComputer`, `#reattachSurface`, `#ensureHelpers`).
- Deduplicate the triplicated worker/virtual-input spawn blocks and profile/XDG derivation; one capacity check.
- Delete Cage leftovers: `leftoverCage.ts`, `botDesktopRollout.ts`, unused `OMARCHY_BOT_SCREEN_WEBRTC_PORT` in `tests/integration/helpers/harness.ts:52`.

- [x] Reattach tests at the BotComputer interface (scripted binaries).
- [x] No behaviour change visible at the runtime seam.

## Answer

`botComputer.ts` owns the Bot Computer: headless Sway compositor, D-Bus session bus, persistent profile and XDG derivation, `computer.json` on-disk state, reattach, and the generation. `swayBotScreenRuntime.ts` dropped from 1,932 to 1,323 lines and keeps only the Screen half (output, workspace, Bot Desktop, capture, WayVNC/RFB, input lease), delegating every computer operation to one `BotComputerRuntime`.

Settled decisions, as built:

- **One generation, owned by the Bot Computer.** `BotScreenProvision` lost `generation`; `BotScreenRuntime` reports `readonly generation` — the computer generation it attached under. The manager persists that number into `bot_surfaces.runtime_generation` after start and after reconcile instead of minting its own, so `desktopSession.runtimeGeneration`, the broker's input fence, the runtime dir, the worker's `OMARCHY_BOT_RUNTIME_GENERATION`, the input helper, and the capture unit all carry one value. A Screen component restart reattaches at the same generation; only a compositor replacement changes it. `surface.json` dropped its separate `computerGeneration`.
- **One recovery owner.** `BotComputerRuntime.ensure()` reuses a live computer, else validates `computer.json` + live sockets + owned PIDs + profile dirs, else discards and starts. Screen reattach stays with the adapter's `reconcile`, which asks the computer for its generation.
- **One capacity check** (`BotComputerRuntime.capacity`, read by output allocation) and **one helper spawn** (`#startHelpers`, used by start, reattach, and `#ensureHelpers`). The duplicated `#readIdentity`/`#waitForSocket` bodies moved to `botScreenWaylandHelpers.ts`.
- **No output is stolen.** Allocation counts an output as claimed by a live session *or* by a retained Screen whose desktop is still running and has not been reattached yet.
- **Cage leftovers deleted**: `leftoverCage.ts`, `botDesktopRollout.ts`, their `main.ts` wiring (including the `botDesktopRollout` status field), the `DESTROY_LEFTOVER_CAGE` guard, the dead `processAlive`, and the unused `OMARCHY_BOT_SCREEN_WEBRTC_PORT` in the harness.

Tests at the deepened interface: `tests/integration/bot-computer.test.ts` drives `BotComputerRuntime` with scripted binaries (one start and one `computer.json` generation; reattach at the same generation and profile; discard a dead compositor; orphan cleanup that spares unrelated processes; stop). Reattach and output-retention regressions live in `bot-screen-sway-runtime.test.ts`.

Review findings across two rounds, all fixed: the computer and its Screens still used different generations (now one); recovery could hand a replacement Screen an output a live Screen still owned (now inventoried, with a regression that fails without the fix); the orphan-cleanup test still ran through the Screen adapter (moved to `BotComputerRuntime.reattach`). Final verdict: APPROVED.

Commits: `22e95c3`, `e5c879b`.

## Comments

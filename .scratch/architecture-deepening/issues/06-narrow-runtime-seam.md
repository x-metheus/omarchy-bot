# 06: Narrow the Bot Screen runtime seam

**Type:** task
**Status:** resolved
**Blocked by:** 05

**What to build:** Move platform-neutral policy above `BotScreenRuntimeAdapter` (`botScreenManager.ts:110-155`) so the Sway adapter and the fake implement the same narrow contract: deliver input event, capture, route/launch window, lifecycle.

Decisions (settled):
- Action→event translation (click → motion/press/release; key chords press then release in reverse; `linuxKeyChord`, `swayBotScreenRuntime.ts:220-238, 1213-1247`) moves above the seam; both adapters are Linux/evdev.
- Authority checks live in the lease (ticket 05), not in adapters.
- One adapter contract test suite runs against the fake and against the Sway adapter driven by scripted binaries; real-Sway conformance stays behind its flags.
- Collapse the ad-hoc test doubles (`computer.test.ts:91` ControlledRuntimeAdapter, `agent-computer-tool.test.ts:52`, `helpers/swayBotScreen.ts:259`) onto the fake where possible.

- [x] Shared contract suite green on both adapters.
- [x] Fake models shared-compositor exit for all Screens together.

## Answer

`BotScreenRuntime` lost `act`. The action vocabulary, the evdev key table, and the event shapes now live above the seam in `botScreenManager.ts` (`runBotScreenAction`, `deliverScreenInput`, `linuxKeyChord`, `resolveFocusMatches`); every adapter implements only `listWindows`, `focusWindow(window)`, `launch({app|url})`, `notify`, capture, input delivery, and lifecycle. No adapter sees a `ComputerAction`.

Settled decisions, as built:

- **Action→event translation moved up.** `click` becomes motion/press/release, a key chord presses in order and releases in reverse, and coordinates, buttons, chords, and launch targets are validated once in the manager. `tests/integration/bot-screen-action-policy.test.ts` covers that policy through the fake.
- **Authority lives in the lease.** `BotScreenManager.act(owner, action, send?)` takes the lease's event sink instead of an authority object, and `ScreenInputLease` hands it down from `performBotInput`; the epoch argument it used to pass to `run` is gone. The broker no longer builds a `ComputerInputAuthority` per action.
- **One contract suite, two adapters.** `tests/integration/bot-screen-runtime-contract.test.ts` runs the same seven checks against `FakeBotScreenRuntimeAdapter` and against `SwayBotScreenRuntimeAdapter` driven by scripted binaries: capture PNG, one capture stream, window routing in Screen coordinates, single-window focus, launch, the input-authority handshake, and stop. Real-Sway conformance stays behind `OMARCHY_BOT_REAL_SWAY`.
- **Shared-compositor exit.** `FakeBotScreenRuntimeAdapter.exitSharedCompositor()` exits every running Screen together, and `bot-screen-lifecycle` asserts both Screens fail with the same compositor outcome and retry at generation 2.
- **Doubles collapsed.** `ControlledRuntimeAdapter` (`computer.test.ts`) and `AgentToolRuntimeAdapter` (`agent-computer-tool.test.ts`) are deleted; both suites use the fake, which gained `setWindows`, `focusRequests`, capture gating/counters, input concurrency counters, and `actionsStarted` to keep the behaviour they proved. `helpers/swayBotScreen.ts` keeps only its Supervisor worker seam (retired in ticket 08) and now also exposes the launched `application` and `windowsFor` for the contract suite.

Review: APPROVED on the first round.

Commits: `3520375`.

## Comments

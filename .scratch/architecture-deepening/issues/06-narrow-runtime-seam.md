# 06: Narrow the Bot Screen runtime seam

**Type:** task
**Status:** claimed
**Blocked by:** 05

**What to build:** Move platform-neutral policy above `BotScreenRuntimeAdapter` (`botScreenManager.ts:110-155`) so the Sway adapter and the fake implement the same narrow contract: deliver input event, capture, route/launch window, lifecycle.

Decisions (settled):
- Action→event translation (click → motion/press/release; key chords press then release in reverse; `linuxKeyChord`, `swayBotScreenRuntime.ts:220-238, 1213-1247`) moves above the seam; both adapters are Linux/evdev.
- Authority checks live in the lease (ticket 05), not in adapters.
- One adapter contract test suite runs against the fake and against the Sway adapter driven by scripted binaries; real-Sway conformance stays behind its flags.
- Collapse the ad-hoc test doubles (`computer.test.ts:91` ControlledRuntimeAdapter, `agent-computer-tool.test.ts:52`, `helpers/swayBotScreen.ts:259`) onto the fake where possible.

- [ ] Shared contract suite green on both adapters.
- [ ] Fake models shared-compositor exit for all Screens together.

## Comments

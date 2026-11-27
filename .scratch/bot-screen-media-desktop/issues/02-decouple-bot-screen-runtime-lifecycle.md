# 02: Decouple Bot Screen runtime lifecycle

**What to build:** Preserve the existing nested-Hyprland Bot Screen behavior while making compositor setup, output readiness, Bot Desktop readiness, application lifetime, capture/input attachment, recovery, and teardown private to one compositor-neutral Bot Screen runtime boundary. Alacritty and Hyprland-specific control must no longer define the manager's product-level lifecycle contract.

**Blocked by:** None (can start immediately).

**Status:** resolved

> **Historical prefactor:** preserving nested-Hyprland behavior was the then-current runtime. Current compositor is Computer ADR 0008. Do not restore Hyprland as production. Accounting: [requirement map](../../shared-workspace-desktop-boundary/requirement-map.md#media-and-desktop-specification).

- [x] Bot Screen callers continue to provision, observe, input, recover, and stop Screens through Bot-owned lifecycle and operation results rather than compositor commands or process identifiers.
- [x] The current nested-Hyprland implementation still reaches ready state, captures the correct output, accepts existing helper input, and tears down completely.
- [x] The manager's readiness contract describes a private Wayland socket, configured output geometry, ready desktop surface, input helper, and computer worker without naming Hyprland, `hyprctl`, or Alacritty.
- [x] Hyprland-specific output creation, output discovery, application checks, and cleanup remain encapsulated inside the current runtime implementation during the prefactor.
- [x] Application exit and compositor exit are represented as distinct runtime outcomes even though the existing implementation may still treat either as fatal until the lightweight Bot Desktop lands.
- [x] Runtime facts such as compositor type, socket names, process identifiers, and command arguments are not added to persistence or public API contracts.
- [x] Existing Bot Screen lifecycle, restart reconciliation, stale-generation rejection, sibling failure isolation, capacity admission, and permanent deletion behavior remain green.
- [x] No second production runtime is enabled by this ticket; it creates the single seam used by the later Cage slice.

## Answer

`BotScreenManager` now consumes one compositor-neutral runtime contract whose completed readiness evidence covers the compositor, private Wayland connection, configured output geometry, desktop surface, capture, input, and computer worker. Runtime component exits carry typed outcomes, including distinct application and compositor exits, while the manager preserves the existing fatal recovery behavior and public lifecycle.

The nested-Hyprland adapter remains the only production implementation. Its socket discovery, output transition, application readiness, capture/input attachment, worker startup, supervised teardown, restart cleanup, and permanent profile destruction remain private. Focused lifecycle coverage exercises both exit outcomes and proves each failure remains isolated from ready sibling Screens.

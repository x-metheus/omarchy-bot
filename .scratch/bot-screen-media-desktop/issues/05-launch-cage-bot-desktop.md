# 05: Launch a persistent Cage Bot Desktop

**What to build:** Allow one Bot Screen to run on a pure-headless Cage compositor and present a persistent neutral Bot Desktop instead of an Alacritty sentinel. The user can observe and control the Screen, launch a real application, interact with its transient dialogs, and close the application without destroying the Bot Screen.

**Blocked by:** 02 / Decouple Bot Screen runtime lifecycle.

**Status:** resolved

> **Application-profile note:** the per-Bot config/state/cache line below is historical fixture/runtime packaging, not a current product requirement to manage browser profiles, Cookies, or logins. ADR 0009 leaves those to Agents and applications. Accounting: [requirement map](../../shared-workspace-desktop-boundary/requirement-map.md#media-and-desktop-specification).

- [x] A selectable Cage runtime launches in a private mode-0700 runtime with a pure headless backend and no dependency on the host Wayland display, full Omarchy session, or global activation environment.
- [x] The selected 1080p or 720p profile creates an explicit output whose logical geometry, video geometry, scale, and geometry generation match the public Bot Screen contract.
- [x] A minimal persistent Bot Desktop commits a neutral surface and becomes the runtime's application-readiness proof; Alacritty is not required.
- [x] The Bot Desktop remains alive when a launched application exits and does not itself add panels, wallpaper services, portals, notification daemons, or clipboard bridges.
- [x] The computer worker launches applications only into the owning Bot Screen's Wayland socket and per-Bot config/state/cache profile.
- [x] The active application fills the usable output appropriately, and transient dialogs remain visible, focused, capturable, and controllable.
- [x] The existing output-bound virtual pointer/keyboard helper reaches ready state and supports motion, buttons, scroll, key transitions, and one-way paste on Cage.
- [x] Fresh snapshot capture returns the Cage Bot Screen's pixels and never captures the Shared Screen.
- [x] Runtime readiness requires the Cage socket, output, committed Bot Desktop surface, input helper, and computer worker.
- [x] Nested Hyprland remains the production default in this ticket; Cage is selectable for the real smoke and subsequent lifecycle work without duplicating product-level APIs.

## Answer

`OMARCHY_BOT_SCREEN_RUNTIME=cage` now selects a pure-headless Cage adapter behind the existing Bot Screen manager interface, while `hyprland` remains the default. The adapter creates one private runtime and per-Bot profile, configures the requested headless output explicitly, waits for a purpose-built neutral Bot Desktop to commit at that geometry, then attaches fresh capture, native input, and the Surface-bound computer worker before reporting ready. Applications launch directly from desktop entries or executable names in that worker's private Wayland/profile environment; their exit leaves the Desktop and Screen alive. Focused adapter, worker-launch, lifecycle, and opt-in real Cage dialog smoke coverage exercise the contract without introducing a second Computer interface.

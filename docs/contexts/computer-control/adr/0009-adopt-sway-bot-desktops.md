# Adopt one private Sway Bot Computer

Status: accepted on 2026-09-06; production cutover completed on 2026-09-07; amended on 2026-09-08 from one compositor per Bot Screen to one shared Bot Computer.

The production runtime is one pure-headless Sway Bot Computer with a private Wayland socket, Sway IPC socket, D-Bus session bus, home, and XDG profile. Each active Bot Screen receives one headless output and one `bot-<surfaceId>` workspace inside that compositor. Native Sway IPC filters window enumeration by workspace and moves windows created by `open_app` or `open_url` to the requesting Screen.

Applications are Bot Computer-owned rather than Surface-worker descendants. Stopping one Surface worker cannot terminate the shared browser or another Screen's application. The Bot Computer profile persists across Screen deletion and daemon generations; supported URL launches select an installed browser against that shared profile. This is application-state sharing, not a claim that separate processes can safely mutate every application's internal state concurrently.

Sway exposes one effective input seat and global focus. The runtime serializes input across Screens, focuses the target workspace immediately before mutation, and holds the lease for the complete Agent action or human Web Control interval. Per-Screen controller epochs, stale-generation checks, held-input release, and Takeover remain enforced at the public boundary.

WayVNC remains an on-demand **view-only** RFB projection. Remote input and clipboard are disabled so RFB cannot bypass Computer Broker authority. Preview capture and Agent screenshots target the requesting output directly.

The Host Session is never used as the Bot Computer. Child environment is explicit and private; production transient units do not mutate the global user-manager or D-Bus activation environment. Cleanup targets verified private-runtime processes and named transient units. Invalid retained state is discarded without trusting stale PIDs.

Computer ADRs 0007 and 0008 remain historical evidence. Their per-Bot compositor, private per-Bot profile, and independent-seat requirements are superseded. Cage remains removed and has no automatic fallback; the one-shot leftover-Cage cleanup guard has been deleted too.

Automated real-Sway conformance passed on 2026-09-08 for two routed Screens, shared profile/runtime markers, Agent control, selected-view projection, browser URL reuse, deletion/reprovision, and host environment isolation. Human top-bar, shortcut, and ordinary Host Session acceptance remains pending.

Evidence and bounded claims remain recorded in [the lightweight runtime comparison](../../../research/lightweight-bot-desktop-runtimes.md), [the Wayland backend research](../../../research/wayland-computer-use-backends.md), and the generated conformance report under `.scratch/sway-bot-desktop-runtime/`.

# 04: Self-contained Sway runtime bundle

**What to build:** The Bot Computer runs from one CI-built, checksum-pinned bundle (Sway, wlroots, WayVNC and its libraries, wlr-randr, Xwayland, grim, a D-Bus daemon, and the capture, input, and bot-desktop helpers) that runs on glibc and musl hosts, instead of downloading Arch Linux packages. Host binaries remain a development override only.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] CI builds the bundle from pinned sources and publishes it with a SHA-256 sidecar.
- [ ] The runtime supply fetches and verifies the bundle and refuses a checksum mismatch without extracting.
- [ ] Real-Sway conformance passes on an Ubuntu 22.04 container using only the bundle (Seam 3).
- [ ] Screenshots and the Bot Computer D-Bus session work on a host without grim or a D-Bus daemon installed.
- [ ] An X11-only test client opens and is captured on a Bot Screen.
- [ ] Arch package URLs are removed from the runtime supply.

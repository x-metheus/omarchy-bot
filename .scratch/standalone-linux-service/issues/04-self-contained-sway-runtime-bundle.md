# 04: Self-contained Sway runtime bundle

**What to build:** The Bot Computer runs from one CI-built, checksum-pinned bundle (Sway, wlroots, WayVNC and its libraries, wlr-randr, Xwayland, grim, a D-Bus daemon, and the capture, input, and bot-desktop helpers) that runs on glibc and musl hosts, instead of downloading Arch Linux packages. Host binaries remain a development override only.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] CI builds and verifies the bundle from pinned sources, and the runtime packager embeds it.
- [x] The runtime supply fetches and verifies the bundle and refuses a checksum mismatch without extracting.
- [x] Real-Sway conformance passes on an Ubuntu 22.04 container using only the bundle (Seam 3).
- [x] Screenshots and the Bot Computer D-Bus session work on a host without grim or a D-Bus daemon installed.
- [x] An X11-only test client opens and is captured on a Bot Screen.
- [x] Arch package URLs are removed from the runtime supply.

## Comments

The Bot Computer runs from one pinned `tar.gz` (`fc4b7ec887c6b5ccad7f62706b4e5a186e63eaeb3e8f70636e641af241a52f94`) instead of Arch packages. A second build produced the same archive bytes. The supply refuses a bundle whose marker or checksum does not match the pin. Host binaries are used only when every tool is set explicitly.

`sh scripts/sway-runtime/conformance/run.sh` evidence: Ubuntu 22.04 `bun test tests/integration/bot-screen-sway-bundle-conformance.test.ts` — 3 pass, 0 fail (no host Sway, grim, D-Bus, Xwayland, or compiler). That run captured PNG and native frames, called `ListNames` on the private bus with bundled `dbus-send`, and captured an X11-only client after input. Alpine 3.21.3 musl smoke started every launcher through the bundled loader.

`bun test` of the supply, computer, runtime, and projection suites: 45 pass, 0 fail. `tsc --noEmit -p tsconfig.json` reports no daemon errors; remaining web/site diagnostics match the pre-existing tree and are outside this ticket.

WayVNC's listen and control sockets live under the runtime root (`wv-<surface id>.sock` / `.ctl`). The generation directory is already near the 107-byte `sun_path` limit, and WayVNC's default `$XDG_RUNTIME_DIR/wayvncctl` does not fit there.

The bundle ships inside the runtime archive. `scripts/package-plugin-runtime.sh` takes the built `.tar.gz` as its third argument, refuses a SHA-256 that does not match the descriptor, and extracts it under `sway/` with the `.omarchy-bot-runtime` ready marker; the Service reads `<dataDir>/runtime/current/sway`. `.github/workflows/sway-runtime.yml` verifies the pin and runs bundle conformance but publishes no release, and `.github/workflows/plugin-runtime.yml` builds the bundle and passes it to the packager.

Ticket 14 ships the CJK font set in that same runtime archive (runtime/current/fonts) and drops GPU-only Mesa libraries from the Sway bundle; in-archive Sway resolution is unchanged.

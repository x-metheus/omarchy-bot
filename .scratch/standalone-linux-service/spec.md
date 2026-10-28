# Standalone Linux Service

**Status:** ready-for-agent

Architecture sources: [ADR 0013](../../docs/adr/0013-run-a-standalone-linux-service.md) (standalone Service, install-only Omarchy plugin), [ADR 0014](../../docs/adr/0014-require-paired-device-tokens.md) (paired device tokens, supersedes ADR 0004), [Computer ADR 0011](../../docs/contexts/computer-control/adr/0011-bundle-one-sway-bot-computer.md) (one bundled Sway Bot Computer, tabbed layout). ADR 0009, Computer ADR 0009, ADR 0010, and the Local Sidecar / This Device rules of ADR 0011 remain in force.

## Problem Statement

Omarchy Bot only runs as a child of Omarchy Shell on Omarchy x86_64. The launcher refuses any other distribution, the Bot Computer's Sway runtime is downloaded as Arch Linux packages that only load on Arch-like systems, and the daemon's lifetime is the Shell's, so reloading Omarchy Shell interrupts every active Turn and tears down the Bot Computer. Users on Ubuntu, Fedora, Debian, or any other distribution cannot run it at all, and nobody can run it on a headless machine such as a cloud VM, even though the Bot Computer itself is already headless and never needed the user's desktop.

The daemon also has no authentication. Its loopback listener is safe only on a single-user laptop; on a shared workstation any local account can drive the Bots' shells, files, and Bot Screens, and remote use from another machine is impossible without exposing an unauthenticated listener.

Inside Bot Screens, the default split-tiling layout shrinks every window whenever another opens, which produces narrow, unfamiliar screenshots for Agents and an awkward surface for humans in Web Control. Headless hosts additionally lack a browser and fonts, so `open_url` fails and pages render as missing glyphs, especially CJK text.

## Solution

The daemon becomes the **Service**: a standalone headless process that runs on any x86_64 Linux host, with or without a desktop, started by interchangeable **Launchers** (a systemd unit or a container entrypoint) through one `serve` entry. One installer and one checksum-verified runtime archive serve every host without root or a host package manager. The archive carries a self-contained Bot Computer runtime (Sway and its dependencies, built to run on any glibc or musl distribution) and fonts, and the installer installs the separate checksum-pinned browser pack by default, so every Service Host runs the identical Bot Computer whatever its own desktop is.

Every Bot Client connects as a **Paired Device**: the Service Host issues a one-time pairing code, the client exchanges it for a revocable device token, and every HTTP request and WebSocket requires that token, loopback included. Non-loopback binding requires TLS. Installation ends by opening a one-time pairing URL, so ordinary local use stays one click.

Without a user systemd manager (containers, non-systemd distributions), the Service supervises plain child processes and still tears them down precisely. A container image packages the Service for cloud VMs.

Bot Screen workspaces use a tabbed layout: one window fills the Screen, the others remain visible as titled tabs, and dialogs float centered.

The Omarchy plugin becomes an independent, Omarchy-only, install-only package in this monorepo: enabling it installs and starts the Service through the shared installer, disabling it stops the Service, removing it uninstalls the Service but keeps user data. It no longer parents the daemon, so Omarchy Shell reloads no longer affect Bots.

## User Stories

1. As an Ubuntu user, I want to install Omarchy Bot with one command, so that I can use AI teammates without running Omarchy.
2. As a Fedora user, I want the same installer to work on my distribution, so that I do not need distribution-specific instructions.
3. As an Arch, Debian, openSUSE, or Alpine user, I want the Service to run on my distribution, so that support is not tied to one package ecosystem.
4. As a user on any distribution, I want installation to need neither root nor my system package manager, so that installing Omarchy Bot cannot change my system.
5. As a user whose own desktop is GNOME, I want Bot Screens to work exactly as they do on Omarchy, so that my desktop choice does not matter.
6. As a user whose own desktop is KDE, Hyprland, an X11 window manager, or nothing at all, I want the same Bot Computer, so that behavior is identical everywhere.
7. As a cloud user, I want to run the Service on a VM with no desktop, so that my Bots keep working while my laptop is closed.
8. As a cloud user, I want a container image with one state volume, so that I can deploy and back up the Service with standard tools.
9. As a cloud user, I want the container to supervise the Bot Computer without systemd, so that Bot Screens work inside a container.
10. As a user of a distribution without systemd, I want the Service to run and clean up its children, so that a missing user manager is not a blocker.
11. As a user, I want the Service to keep running when no one is logged in on a server, so that Bots continue unattended.
12. As a user, I want `omarchy-bot status` to tell me whether the Service is running, on which address, and why it failed if it did, so that I do not need desktop notifications to diagnose startup.
13. As a user, I want `omarchy-bot doctor` to list every missing prerequisite precisely, so that a failed start on an unusual distribution is actionable.
14. As a user, I want `omarchy-bot start`, `stop`, `update`, and `uninstall`, so that I can manage the Service the same way on every distribution.
15. As a user, I want uninstalling to keep my Bots, Threads, Shared Workspace, and Bot Computer profile unless I ask otherwise, so that removal is not destructive.
16. As a user, I want updates to download a checksum-verified runtime and refuse a mismatched one, so that a corrupted or tampered download never runs.
17. As a user, I want installation to end by opening a paired Web UI in my local browser, so that first use is one click.
18. As a user, I want to pair another browser or Omarchy Bot install with a short one-time code, so that adding a client is explicit.
19. As a user, I want to see and revoke each Paired Device, so that a lost laptop or phone loses access immediately.
20. As a user on a shared workstation, I want other local accounts to be unable to use my Service, so that loopback is not a security hole.
21. As a user, I want every route, the projection sockets, the RFB socket, and the Sidecar device channel to reject unpaired callers, so that no path bypasses pairing.
22. As an operator, I want an unauthenticated health probe that reveals no Bot, Thread, or host data, so that container orchestration and monitoring work without a token.
23. As a remote user, I want to reach my cloud Service through an SSH tunnel before any remote feature exists, so that I have a safe documented path from day one.
24. As a remote user, I want to bind the Service to a network address with my own certificate or behind a declared TLS proxy, so that I can reach it without a tunnel.
25. As a remote user, I want the Service to refuse to bind a non-loopback address without TLS, so that I cannot accidentally serve tokens in plaintext.
26. As a remote user, I want plugin account authorization (OAuth) to complete from my remote client, so that connecting Services does not require a browser on the server.
27. As a user with several clients open, I want Takeover and input leases to arbitrate Web Control between them, so that two Paired Devices never interleave input on one Bot Screen.
28. As an Omarchy Bot (Tauri) user on another machine, I want its Local Sidecar to authenticate with my device token, so that This Device keeps working against a paired Service.
29. As an Agent, I want each Bot Screen window to fill the Screen, so that pages render at their desktop width and screenshots are unambiguous.
30. As an Agent, I want the other open windows visible as titled tabs, so that I can see what is open and switch by clicking a tab.
31. As an Agent, I want dialogs, pop-ups, and file pickers to float centered over the window, so that they look like ordinary desktop dialogs.
32. As a human in Web Control, I want the same tabbed surface, so that taking over a Bot Screen feels familiar.
33. As an Agent on a host without a browser, I want `open_url` to open a working browser, so that web tasks do not depend on what the host installed.
34. As an Agent on Ubuntu, I want `open_url` to skip snap-confined browsers and use a working one, so that confinement does not break the private Bot Computer profile.
35. As a user reading Chinese, Japanese, or Korean pages in a Bot Screen, I want correct glyphs, so that headless hosts do not render empty boxes.
36. As a user with X11-only applications, I want them to run inside Bot Screens, so that Xwayland is available regardless of the host.
37. As a user, I want Bot Computer screenshots and the D-Bus session to work even if my host lacks the corresponding tools, so that missing host packages do not break Bot Screens.
38. As an Omarchy user, I want `omarchy plugin add` to keep working, so that the Omarchy install path is unchanged for me.
39. As an Omarchy user, I want enabling the plugin to install and start the Service, so that the plugin remains the one-step Omarchy install.
40. As an Omarchy user, I want reloading or restarting Omarchy Shell to leave my Bots running, so that Shell maintenance never interrupts a Turn.
41. As an Omarchy user, I want disabling the plugin to stop the Service and removing it to uninstall the Service while keeping my data, so that the plugin lifecycle matches expectations.
42. As an Omarchy user who already installed the Service with the CLI, I want enabling the plugin to reuse that Service, so that I never get two Services.
43. As a maintainer, I want the plugin to be a separate workspace package that depends only on the published installer and runtime archive, so that it can move to its own repository later without changes.
44. As a maintainer, I want CI to run the real Bot Computer conformance on several distributions, so that "works on all Linux" is verified rather than assumed.
45. As a maintainer, I want the Bot Computer runtime built in CI from pinned sources with a recorded checksum, so that the runtime is reproducible and auditable.
46. As a maintainer, I want the README and product boundary to state x86_64 Linux support, the SSH-tunnel path, and the container path, so that the documented contract matches the product.
47. As a user, I want the Service to keep the Host Session untouched when one exists, so that standalone operation does not weaken host safety.
48. As a user, I want Voxtype dictation to remain available when my host has Voxtype and hidden otherwise, so that dictation degrades cleanly.

## Implementation Decisions

- **Service and Launchers.** One `serve` entry starts the Service from an installed runtime. Launchers (a systemd user unit, a system unit running as a dedicated user, and a container entrypoint) call only that entry and own no business behavior. The distribution check is removed from the generic path; the architecture check (x86_64) remains. When no runtime directory is provided by the host, the Service creates a private 0700 directory and uses it for its locks, sockets, and Bot Computer runtime.
- **One Service per user.** A per-user lock prevents a second Service. The installer and the plugin detect an installed Service and reuse it.
- **Installer and CLI.** One installer unpacks the checksum-verified runtime archive into the user's data directory, installs a systemd user unit when a user manager exists, and exposes `install`, `start`, `stop`, `status`, `pair`, `devices`, `revoke`, `update`, `uninstall`, and `doctor`. Lingering is suggested by `doctor` when the host has no persistent login. The stale repository-root user unit is replaced by the installer's unit. Archive extraction does not depend on host `zstd`.
- **Health probe.** An unauthenticated health route reports only liveness and Service version. It is the sole route besides the pairing exchange that accepts unpaired callers.
- **Pairing and device tokens (ADR 0014).** The Service issues short-lived one-time pairing codes from the Service Host (CLI) and a one-time pairing URL the installer opens locally. A client exchanges a code for a device token bound to a named Paired Device. Tokens are stored hashed, are individually revocable, and never appear in logs, model-visible output, or the Shared Workspace. Every HTTP route and WebSocket upgrade (conversation, projection preview/control, RFB, Local Sidecar device channel) requires a valid token; unpaired requests receive 401. The Web client and the API client carry the token; the Local Sidecar presents the token of the Omarchy Bot install that started it, and its `dev_<32hex>` This Device claim is unchanged. This is a breaking public-protocol change with no unauthenticated compatibility mode.
- **Remote binding.** A non-loopback bind requires either an operator certificate or a declared trusted TLS-terminating proxy; otherwise startup fails with a clear error. Per ADR 0015, OAuth callbacks use the Service origin (including headers from the declared trusted proxy), never the initiating client's origin. Completion reaches Omarchy Bot through the event stream.
- **Supervision without systemd.** Transient units remain the preferred isolation when a user manager exists. Otherwise the Service starts Bot Computer and worker processes as owned child process groups and tears them down by verified identity, preserving the existing targeted-teardown and no-host-environment-import guarantees.
- **Bot Computer runtime bundle (Computer ADR 0011).** CI builds one self-contained x86_64 bundle containing Sway, wlroots, WayVNC and its libraries, wlr-randr, Xwayland, grim, a D-Bus daemon, and the capture, input, and bot-desktop helpers, statically or with all non-libc libraries bundled, runnable on glibc and musl hosts. The runtime supply resolves this bundle by pinned checksum instead of Arch Linux packages. Explicit host binaries remain a development override only. The Bot Computer keeps headless Sway with the pixman renderer.
- **Tabbed Bot Screen layout.** The generated Bot Computer configuration makes every workspace tabbed, keeps a readable tab/title bar, hides edge borders, floats dialogs, pop-ups, and portal pickers centered, and focuses activated windows. Window routing per Screen workspace is unchanged.
- **Browser and fonts.** The Bot Computer profile carries a portable browser and a font set covering Latin and CJK. `open_url` launches the browser from the checksum-pinned pack installed by `install`/`update`, never launches a snap-confined browser, and uses a host browser only on the explicit `OMARCHY_BOT_BROWSER=host` opt-in. The shared browser profile of Computer ADR 0009 is unchanged.
- **Container image.** The image contains the runtime archive contents, runs the `serve` entry as an unprivileged user, keeps all state on one volume, logs to stdout, exposes the health route, and starts with pairing required.
- **Omarchy plugin package (ADR 0013).** The plugin moves into its own workspace package. The root manifest only points Omarchy's plugin manager at it. On enable it runs the shared installer (or reuses an installed Service) and starts the user unit; on disable it stops it; on removal it uninstalls the Service and keeps user data. It depends only on the published installer and runtime archive and is never imported by other packages, enforced by the dependency rules. Quickshell no longer parents the daemon, and the supervisor lifeline is removed from the Service.
- **Host-optional features.** Voxtype dictation stays a Service capability reported unavailable when absent. Startup failures are reported through the Service log and `status`, not `notify-send`.

## Testing Decisions

- Good tests exercise external behavior only: HTTP/WebSocket responses, installer and Launcher effects on a fixture home, and observable Bot Screen behavior (pixels, windows, input). They never assert internal module structure.
- **Seam 1, Service API harness** (prior art: the integration harness used by daemon, Local Sidecar, and screen-projection suites). Covers pairing exchange, token enforcement on every route family and socket, revocation, the health probe's data minimization, non-loopback TLS refusal, and supervision without systemd (harness configured with no user manager).
- **Seam 2, installer and Launcher fixtures** (prior art: the Omarchy plugin and cloud-environment suites, which run the launch scripts against fake `os-release`, curl, and Bun in a temporary home). Covers generic install on a non-Omarchy fixture, checksum refusal, runtime-directory fallback, one-Service-per-user reuse, CLI lifecycle, uninstall data retention, and the plugin package calling the installer on enable, disable, and remove.
- **Seam 3, Bot Computer contract and real-Sway conformance** (prior art: the runtime contract suite run against the fake and scripted Sway adapters, and the real-Sway conformance suite behind its environment flag). Covers the bundle as the runtime source, tabbed layout and floating dialogs, `open_url` with the portable browser and snap avoidance, CJK glyph rendering, and Xwayland availability.
- **Distribution matrix.** CI runs Seam 3's real-Sway conformance plus an install-and-serve smoke test in Ubuntu 22.04 and 24.04, Debian 12, Fedora, Arch, openSUSE, and Alpine containers using the published bundle. Headless pixman rendering requires no display or GPU in CI.
- Chromium tests are not evidence of Tauri WebView behavior (ADR 0010).

## Out of Scope

- macOS and Windows Service Hosts, including a VM-hosted Bot Computer.
- arm64 builds.
- Matching the user's desktop environment or running GNOME/KDE Bot Computers.
- Omarchy host integrations in the plugin (notifications, theme sync, client shortcuts) and the plugin acting as a client of a remote Service.
- Moving the plugin package to its own repository (a later step this spec prepares for).
- Dictation captured on a remote client.
- Accounts, passwords, roles, or multiple users sharing one Service.
- Distribution packages (deb, rpm, AUR, Flatpak, Snap).
- Renaming the product.
- Tauri packaging and WebView verification.

## Further Notes

- The pairing cutover breaks every existing client at once; the installer-opened pairing URL is what keeps local Omarchy use one click after upgrade.
- Software rendering is CPU-bound; Bot Screen admission limits should reflect host size, with 720p as the default on small cloud instances.
- Until remote binding with TLS ships, documentation presents SSH tunnelling or a private network as the only supported remote path.
- Originating discussion: the 2026-10-24 conversation on cross-platform support, narrowed to all x86_64 Linux, a bundled Sway Bot Computer with tabbed layout, a standalone Service with clients, and an install-only Omarchy plugin package.

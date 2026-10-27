# Bundle one Sway Bot Computer for every Linux host

Status: accepted on 2026-10-24; amended on 2026-10-26 so the checksum-verified bundle ships extracted inside the runtime archive rather than as a separate release; amended on 2026-10-26 so the CJK font set ships inside the runtime archive and the bundle omits GPU-only Mesa libraries; amended on 2026-10-26 so the browser arrives as a separate checksum-pinned browser pack installed by `install`/`update` instead of a run-time download. Extends [Computer ADR 0009](0009-adopt-sway-bot-desktops.md); it does not change the shared Bot Computer, routed Screens, or serialized seat. Implementation is tracked by [the standalone Linux Service specification](../../../../.scratch/standalone-linux-service/spec.md).

Every Service Host runs the same Bot Computer: a headless Sway with the pixman renderer, regardless of whether the user's own desktop is GNOME, KDE, Hyprland, X11, or absent. The Service ships that runtime itself as one checksum-verified, self-contained bundle (Sway, wlroots, WayVNC, wlr-randr, Xwayland, grim, a D-Bus daemon, and the capture/input/bot-desktop helpers) built to run on any glibc or musl x86_64 Linux, replacing the downloads of Arch Linux packages. Users watch Bot Screens through the Computer Surface rather than in their own desktop, and the applications inside are ordinary GTK/Qt/Chromium programs that behave the same under any compositor, so matching the host desktop would multiply backends without visible benefit.

Each Bot Screen workspace uses a **tabbed** layout: the focused window fills the Screen, the other windows remain visible as titled tabs, and dialogs, pop-ups, and portal pickers float centered. This keeps an Agent's screenshot complete and unambiguous (no overlap, no shrinking splits) and gives humans a familiar surface in Web Control.

Because headless hosts have no browser or fonts, the Bot Computer profile carries a portable browser while the font set that covers CJK ships inside the runtime archive. The browser is a **browser pack**: Chrome for Testing with its pinned Ubuntu library closure, built and published as its own checksum-pinned artifact beside the browserless runtime archive, and installed by `install`/`update` when the Service Host has no usable browser or the operator passes `--with-browser`. Snapshotting the browser at install time rather than at first graphical use keeps the run-time Service off the network and makes a browserless-host failure actionable (`--with-browser`) instead of a mid-turn download attempt. Host browsers are still used when present and installed natively; snap-confined browsers are not launched, because their confinement requires the real home and runtime directory the Bot Computer deliberately does not share.

## Considered Options

- **Match the user's desktop (GNOME Bot Computer for GNOME users, KDE for KDE users)**: rejected; each desktop needs its own headless launch, capture, input, and conformance, full shells cost hundreds of MB per instance, and GNOME/KDE expose no public Wayland window-management API comparable to Sway IPC.
- **One full desktop session per Bot**: rejected for the cost and shared-profile reasons in Computer ADR 0009.
- **Use the host's Sway packages**: rejected as the default; distro Sway versions drift and are absent on most hosts. Host binaries remain an explicit override for development.
- **Flatpak/Snap packaging of the Bot Computer**: rejected; their sandboxes conflict with transient units, the Shared Workspace, and launching host applications.
- **Default split tiling**: rejected; each new window shrinks every other window, producing narrow responsive layouts the Agent did not ask for.

## Consequences

- Two checksum-pinned artifacts now ship together in the `runtime-<sha>` release: the browserless runtime archive and `omarchy-bot-browser-<version>-x86_64.tar.zst` with its `.sha256` sidecar. A browser version bump is a pin change plus a new pack, and neither artifact is valid without its sidecar.
- The container image and the distribution matrix install the pack at build/install time and run their browser steps with container networking disabled, so no conformance path depends on a run-time download.
- The Bot Computer runtime must pass the same real-Sway conformance on a matrix of distributions, not only on Omarchy.
- Host-environment isolation is unchanged: private runtime, Wayland, Sway IPC, D-Bus, home, and XDG directories; nothing is imported into the host user manager.
- Applications that only work inside GNOME or KDE shells are unsupported in Bot Screens.

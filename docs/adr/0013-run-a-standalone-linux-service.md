# Run Omarchy Bot as a standalone Linux Service

Status: accepted on 2026-10-24; amended on 2026-10-27 so the browser pack is installed by default on every Service Host rather than only when the host lacks a usable browser. Supersedes the "daemon stays bound to Omarchy Shell" part of [ADR 0011](0011-local-sidecar-only-off-host.md) and the Omarchy-only support contract in the README. Implementation is tracked by [the standalone Linux Service specification](../../.scratch/standalone-linux-service/spec.md). Amended on 2026-10-28 by [ADR 0015](0015-omarchy-bot-app-is-the-only-bot-client.md): on graphical hosts the installer and Omarchy plugin also install Omarchy Bot, and Service-side dictation is retired.

The daemon becomes the **Service**: one headless process that owns Bots, Threads, Agents, the Shared Workspace, and the Bot Computer on any x86_64 Linux host, with or without a graphical desktop. Bot Clients (the Web UI in any browser, and Omarchy Bot) connect to it over the existing HTTP and WebSocket contracts. A **Launcher** only starts and stops the Service: a systemd unit or a container entrypoint, both calling the same `serve` entry, and neither owning business behavior. One installer and one checksum-verified runtime archive serve every Linux host; the same installer also installs the separate checksum-verified browser pack by default, so the runtime archive itself stays browserless and every Service Host runs one pinned browser rather than depending on the host's own.

This is possible without moving execution because the Bot Computer never depended on the Host Session: it is a private headless Sway with a software renderer ([Computer ADR 0011](../contexts/computer-control/adr/0011-bundle-one-sway-bot-computer.md)). A cloud VM with no desktop therefore runs the same Bot Computer as a laptop.

## The Omarchy plugin only installs the Service

The Omarchy plugin becomes an independent plugin that works only on Omarchy and whose sole job is to install the Service through the same installer every other Linux host uses: enabling it installs (or reuses) and starts the Service's systemd user unit, disabling it stops that unit, and removing it uninstalls the Service while keeping user data. It carries no business behavior, no host integrations (notifications, theme sync, client shortcuts), and no runtime of its own. The Service's lifetime is no longer the Omarchy Shell's: Quickshell no longer parents the daemon, so a Shell reload or crash does not interrupt Turns or tear down the Bot Computer, and the supervisor lifeline that existed only for Quickshell's SIGKILL is retired. A host has one Service per user whether the plugin or the CLI installed it.

## Considered Options

- **Keep the daemon an Omarchy plugin** ([ADR 0011](0011-local-sidecar-only-off-host.md)): rejected; it blocks every other distro and every headless host for a dependency (Quickshell lifecycle) that adds no business behavior.
- **Keep the plugin as the Service's parent process**: rejected; a Shell reload would keep killing active Bots, contradicting an always-on Service.
- **Give the plugin Omarchy host integrations** (notifications, theme sync, paired client shortcut): rejected for now; they would make the plugin a second product surface with its own behavior to keep in step with the Service.
- **Move the daemon into the Tauri client**: still rejected for the reason in ADR 0011; the always-on computer and plugin lifecycle would split, and a closed laptop would stop the Bots.
- **Per-distro packages (deb, rpm, AUR) as the primary delivery**: rejected for now; one checksum-verified runtime archive plus a Launcher covers every distro without root or a host package manager.
- **macOS and Windows hosts**: out of scope; the Bot Computer is Linux/Wayland, and a VM-hosted Bot Computer is a separate decision.

## Consequences

- The Service never requires a Host Session. When one exists, the Host Session isolation rules of [ADR 0009](0009-share-work-files-isolate-bot-screens.md) are unchanged; when none exists, "never fall back to the Host Session" is trivially true.
- Process supervision cannot assume `systemd --user`. Transient units remain the preferred isolation when a user manager exists; without one (containers, non-systemd distros) the Service supervises plain child processes and still guarantees targeted teardown.
- Host dictation (Voxtype) stays a Service feature that is available only when the host has it. Launcher and startup failures are reported through the Service log, `omarchy-bot status` (unit state, address, last startup failure), and `omarchy-bot doctor` (failed prerequisite, runtime, marker, font, browser pack, unit, launcher, health, and pairing checks), never desktop notifications.
- Every client pairs before it can use the Service ([ADR 0014](0014-require-paired-device-tokens.md)). Remote use goes through an SSH tunnel, a private network, or a non-loopback bind with operator TLS or a declared TLS-terminating proxy; an unauthenticated listener is not supported.
- The plugin becomes its own workspace package in this monorepo and depends only on the published installer, runtime archive, and browser pack, never on Service source. The root `manifest.json` only points Omarchy's plugin manager at that package. The package is expected to move to its own repository later, so nothing outside it may import from it.
- The Local Sidecar and This Device contract in ADR 0011 is unchanged except that "plugin host" now reads "Service Host": Omarchy Bot on the Service Host is a viewer and starts no Sidecar.
- The product keeps the name Omarchy Bot. Renaming is a separate decision.

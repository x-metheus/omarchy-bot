<div align="center">

# Omarchy Bot

**Your AI teammates. Your work files. Runs on x86_64 Linux.**

Create named Bots, work together in Threads, and see their desktop work in Bot Screens.

[![Platform: x86_64 Linux](https://img.shields.io/badge/Linux-x86__64-183D32?style=flat-square)](#installation)
[![Runtime: Bun 1.4+](https://img.shields.io/badge/Bun-1.4%2B-183D32?style=flat-square)](#development)
[![License: MIT](https://img.shields.io/badge/License-MIT-183D32?style=flat-square)](LICENSE)

[Install](#installation) · [Develop](#development) · [How it works](#product-model) · [Design docs](#design-sources)

</div>

---

Omarchy Bot's headless Service owns the Bots, Threads, Agents, Shared Workspace, and Bot Computer. Launchers start an installed runtime through one `serve` entry on x86_64 Linux; the existing Omarchy plugin installs that runtime and starts its systemd user unit.

| Work with teammates | Keep the context |
| :--- | :--- |
| **Give each Bot an identity** | A name, Job/Instructions, and an uploaded or generated avatar. Multiple Bots can use the same Agent. |
| **Follow the work in Threads** | Responses, Thinking, and Tool Calls retain their original order. Per-Bot display settings control what you see, not what is retained. |
| **Watch and take over desktop work** | Each Bot has a routed Screen inside one private Bot Computer, separate from your Host Session. |
| **Share files and application state** | Bots use a Shared Workspace and a shared Bot Computer profile, including browser state. |
| **Hand work to another Bot** | Durable, asynchronous 1:1 mail creates a target-owned Thread without forwarding the source conversation. |

> [!IMPORTANT]
> **Current support:** the Service runs on **x86_64 Linux** with or without a desktop. Install paths are the Omarchy plugin, the generic `install` command, and the container image ([ADR 0013](docs/adr/0013-run-a-standalone-linux-service.md)). The runtime archive ships the Bot Computer bundle and fonts, and installers install the separate browser pack by default; the configured distribution matrix runs in CI. **Not supported:** arm64, macOS, and Windows Service Hosts, including a VM-hosted Bot Computer. **Pi** is the current Agent backend. Other Agents require an adapter and a passing versioned conformance inventory before becoming selectable. The Linux Omarchy Bot application builds as an x86_64 AppImage; see [Linux application](#linux-application). Other client platforms require their own packaged WebView checks.

## Installation

Three install paths share one runtime archive and one `install` command. The Omarchy plugin is the one-step path for Omarchy hosts; the generic installer serves any x86_64 Linux host with a systemd user manager; the container image serves headless and non-systemd hosts.

### Omarchy plugin

Install and enable through Omarchy's official plugin manager:

```bash
omarchy plugin add https://github.com/XMethues/omarchy-bot.git --enable
```

Published runtimes include the built web client, native helpers, application source, and production dependencies. First enable uses a SHA-256-verified release artifact instead of running an install or compiler.

The plugin package only installs the Service. Enable runs the shared installer from the published runtime archive, which also installs the browser pack by default, reuses an already-installed Service, then starts the `omarchy-bot.service` user unit; disable stops that unit and leaves an installed helper watching until re-enable or checkout removal; removing the checkout uninstalls the Service and keeps user data. A graceful Shell teardown leaves the Service and its active Turns running: the teardown helper waits for the Shell to persist the plugin as disabled, which stops the Service, or for the plugin source directory to disappear, which uninstalls the Service and keeps user data. A re-enable ends that wait without touching the running Service, and a teardown with no Shell coming back keeps waiting. Shell hot reload keeps the plugin loaded. The package refuses hosts that are not Omarchy on x86_64; the generic `serve` entry checks no distribution.

<details>
<summary><strong>Runtime delivery and startup diagnostics</strong></summary>

The repository root manifest points Omarchy's plugin manager at `packages/omarchy-plugin`, and Omarchy Shell loads its `Service.qml`.

- **Bun resolution:** PATH, then mise, then a checksum-verified official Bun 1.4.2 download under `OMARCHY_BOT_HOME`.
- **Release artifacts:** `omarchy-bot-runtime-<sha>-x86_64.tar.zst` and `omarchy-bot-browser-<version>-x86_64.tar.zst`, each with its SHA-256 sidecar, published under `https://github.com/XMethues/omarchy-bot/releases/download/runtime-<sha>/`. The runtime archive carries no browser; the browser pack is separate.
- **Runtime location:** `~/.local/share/omarchy-bot/runtime/current/`, or `$OMARCHY_BOT_HOME/runtime/current/` when overridden. Extraction is atomic and keeps the checkout clean and fast-forwardable.
- **Browser pack location:** `~/.local/share/omarchy-bot/runtime/browser/`, or `$OMARCHY_BOT_HOME/runtime/browser/`, beside `current/` so replacing the runtime on `update` keeps the installed pack. `OMARCHY_BOT_BROWSER_PACK_DIR` overrides it.
- **No source fallback:** a network, server, or integrity failure stops startup rather than silently compiling.
- **Failure handling:** there is no supervisor lifeline, no `notify-send` path, and Quickshell does not parent the Service. Install, startup, and unit failures go to the Service log, `omarchy-bot status` (unit state, address, last startup failure), and `omarchy-bot doctor` (prerequisites, installed runtime and markers, fonts, browser pack, unit and launcher, health, pairing). See [Service CLI](#service-cli).

Service log:

```text
~/.local/state/omarchy-bot/service.log
```

Set `OMARCHY_BOT_STATE` to relocate the log and other state. No host packages or Omarchy files are changed. The installed runtime also supports direct Service startup without Omarchy Shell; see below.

</details>

### Any x86_64 Linux host with systemd

The same installer serves every distribution, with no root and no host package manager. Download `omarchy-bot-runtime-<sha>-x86_64.tar.zst` and its `.sha256` sidecar from `https://github.com/XMethues/omarchy-bot/releases/download/runtime-<sha>/`, then run the installer from a checkout or from an extracted archive:

```bash
bun apps/cli/src/main.ts install \
  --archive omarchy-bot-runtime-<sha>-x86_64.tar.zst \
  --checksum omarchy-bot-runtime-<sha>-x86_64.tar.zst.sha256
```

It requires Bun 1.4+, Bash, `flock`, a systemd user manager socket (`$XDG_RUNTIME_DIR/systemd/private`), and a non-root user. `install` verifies the checksum, extracts atomically into `~/.local/share/omarchy-bot/runtime/current/`, writes `$XDG_CONFIG_HOME/systemd/user/omarchy-bot.service` with `ExecStart=<dataDir>/runtime/current/scripts/serve.sh`, enables and starts that unit, waits for `GET /api/health`, then prints `address:`, a one-time `code:`, and `pairing: omarchy-bot://pair?service=…&code=…`. It opens the deep link with `xdg-open` (set `OMARCHY_BOT_OPEN` for a different opener). Enter the address and code in Omarchy Bot's Add Service screen if the app is not registered to open links yet. The origin is `https://` when TLS is configured and `http://` otherwise. An already-installed runtime is reused instead of replaced. The installer registers no desktop hook and writes the `omarchy-bot` launcher described under [Service CLI](#service-cli); `install` and `update` also accept the TLS and proxy flags described under [Remote access](#remote-access).

A host without a systemd user manager cannot use `install`; start the Service with the container path below or with `scripts/serve.sh` directly.

The runtime archive contains no browser. `install` and `update` install the browser pack by default, on every Service Host and even under the host-browser opt-in, where it remains the fallback. Every host therefore runs the same pinned Chrome for Testing build: Agent control needs one known version with launch flags the Service owns, and nothing depends on what the host installed. The daemon launches that browser with `--remote-debugging-pipe`, so the `browser` tool can read the same visible window's accessibility tree and act on it over a private inherited pipe; no TCP debugging port is opened and the browser window stays on the Bot Screen. By default the pack comes from `https://github.com/XMethues/omarchy-bot/releases/download/runtime-<version>/`, inferred from the runtime archive's file name; a local runtime archive without that name needs an explicit `--browser-pack <file-or-https-url>`: a local archive with its adjacent `.sha256` sidecar, or an HTTPS URL whose archive and `.sha256` are both downloaded. `--no-browser-pack` skips the pack entirely. The adjacent `<source>.sha256` sidecar is verified before anything is written, and a mismatch aborts before the unit is installed. The pin an `update` targets is the one in the runtime archive it installs, while `install` reusing an installed Service keeps that runtime's pin. `update` replaces the pack only when the installed pin differs from the target release or the installation is incomplete, and it keeps an unchanged pin only while the installed `browser --version` succeeds, so a same-pin pack that no longer runs is repaired instead of preserved. A repair reuses the release recorded when the runtime was installed; an installation older than that record needs an explicit `--browser-pack`. The pack is extracted to `~/.local/share/omarchy-bot/runtime/browser/`, never onto the host, and `uninstall` removes it with `runtime/`.

A host browser is never used unless you opt in with `OMARCHY_BOT_BROWSER=host` in the installing environment: `install`/`update`/`reconfigure` persist it in the unit and `<dataDir>/service.json`, and an empty value clears it. Any other value is rejected. Snap-confined browsers are skipped even then, and an opted-in host without a usable browser falls back to the pack. Chrome for Testing ships no Widevine module, so DRM-protected video does not play in Bot Screens. Chromium also reports `navigator.webdriver` for the `--remote-debugging-pipe` switch that Agent browser control requires, so some sites can recognize the Bot browser; the Service does not spoof or hide that signal, and such sites may need a human Takeover.

The generated unit records `HOME`, `OMARCHY_BOT_HOME`, `OMARCHY_BOT_STATE`, `OMARCHY_BOT_HOST`, `OMARCHY_BOT_PORT`, `PATH`, `XDG_RUNTIME_DIR`, and, when configured, `OMARCHY_BOT_TLS_CERT`, `OMARCHY_BOT_TLS_KEY`, `OMARCHY_BOT_TRUSTED_PROXY`, and `OMARCHY_BOT_BROWSER`. TLS and proxy settings come from `--tls-cert`/`--tls-key`/`--trusted-proxy` flags or those variables in the installing environment. `install`/`update` leave an existing unit alone unless a TLS flag or one of those three variables is supplied, or `OMARCHY_BOT_BROWSER` is present in the installing environment, in which case they rewrite the unit and restart it instead of only starting it; [Remote access](#remote-access) documents the exact TLS rules. Writing the unit also saves the connection settings to `<dataDir>/service.json` (mode 0600, no host secret) so later CLI commands reach the installed address and scheme.

### Start an installed runtime

From an unpacked runtime, start the Service in the foreground:

```bash
bash /path/to/runtime/scripts/serve.sh
```

In a checkout, `bun run serve` calls the same entry. It requires Linux x86_64, Bash, Bun 1.4+, and `flock`; it performs no installation or downloads. Set `OMARCHY_BOT_BUN` to select a Bun executable. The Service logs to stdout/stderr and listens on `127.0.0.1:7321` by default. Existing `OMARCHY_BOT_HOME`, `OMARCHY_BOT_STATE`, `OMARCHY_BOT_HOST`, and `OMARCHY_BOT_PORT` settings apply.

Without `XDG_RUNTIME_DIR`, the entry creates `/tmp/ob-<uid>` with mode 0700 and exports it for transient sockets and the Bot Computer runtime. The short path leaves room for Linux's Unix-socket pathname limit. A per-user Service lock lives under `/tmp/omarchy-bot-<uid>/`, independent of login sessions and launcher settings. A second launch fails promptly and reports the running Service's PID. The Omarchy plugin starts and stops the Service through its systemd user unit. Shell hot reload keeps the plugin loaded, and a crash or SIGKILL leaves the Service running. A graceful Quickshell teardown also leaves the Service and its active Turns running: the teardown helper waits instead of stopping, and only a persisted disable stops the Service while removal of the plugin source directory uninstalls it and keeps user data.

`GET /api/health` accepts no token and returns only liveness, the Service version, and the client protocol version, for example `{"ok":true,"version":"0.1.0","protocol":1}`. The client protocol is owned by `@omarchy-bot/protocol` and raised on every breaking change. Omarchy Bot checks it before opening the workspace; this app supports protocol 1. A newer Service requires updating Omarchy Bot through the app's update action; an older Service (including one without the field) requires updating the Service on its Linux host. Control requests require a Paired Device token, including on loopback. Non-loopback listeners require TLS or a declared TLS-terminating proxy.

The workspace closes its event connection and cancels reconnects when a later health check reports an incompatible Service. Dropped event connections recheck health before reconnecting. Malformed health responses keep the workspace closed and offer a retry.

### Container on a headless Linux host

Build an x86_64 image from a published runtime archive and its adjacent `.sha256` sidecar:

```bash
bash scripts/build-container-image.sh /path/to/omarchy-bot-runtime-<sha>-x86_64.tar.zst omarchy-bot:local
docker run -d --name omarchy-bot --network host --shm-size=512m \
  --security-opt seccomp=unconfined \
  --mount type=volume,source=omarchy-bot-state,target=/var/lib/omarchy-bot \
  omarchy-bot:local
docker logs omarchy-bot
docker exec omarchy-bot bun /opt/omarchy-bot/runtime/apps/cli/src/main.ts pair
```

Enter the printed address and code in Omarchy Bot's Add Service screen, or open its `omarchy-bot://pair` deep link. For an SSH tunnel, forward `7321` with `ssh -L 7321:127.0.0.1:7321 user@host` and use `http://127.0.0.1:7321` as the address in the app. The default listener is loopback; host networking makes it reachable through that tunnel on Linux. No public registry image is published by this build command. Docker and Bun 1.4+, `curl`, and `unzip` are build prerequisites. The optional third build argument selects the asset cache (default `.lane/container-assets`); cache misses fetch checksum-pinned Bun and Chrome for Testing inputs and build the browser pack from them into the image. Docker build itself runs without network access, using the pinned Ubuntu 22.04 base; pull that base once if absent.

The Service runs as UID/GID 1000. The single named volume contains its database, pairing identity, Threads, artifacts, Shared Workspace, Agent credentials, and Bot Computer application/browser profile. Back up the volume while the container is stopped; recreate containers with the same volume to retain state. A bind mount must already be writable by UID 1000. Keep `HOME`, `OMARCHY_BOT_HOME`, and `OMARCHY_BOT_STATE` at their image defaults so state stays on that volume. Runtime locks and sockets are temporary. The image builds the browser pack into `/opt/omarchy-bot/browser` and sets `OMARCHY_BOT_BROWSER_PACK_DIR` to it, and installs the fonts at build time, so opening a local page in a Bot Screen needs no downloads. Docker stops use SIGINT so the Service closes the Bot Computer and flushes its application profile before exiting.

Use one running container per state volume. On startup the entrypoint clears Chromium's three transient singleton links, whose hostname and temporary socket refer to the previous container; browser profile data remains on the volume.

Before creating a Bot with the real Pi Agent, configure Pi's provider credentials in the persisted home; credentials alone leave a fresh Agent `unconfigured`. Readiness also requires an authentic passing Pi conformance record for the image's exact Agent version, which the Service reads from `<dataDir>/conformance/pi-<version>.json`. A paired `GET /api/agents` reports the Pi entry's `version` field. No supported command writes such a record into a production Service or the container's state volume, so this remains a provisioning gap.

`bun test tests/conformance/pi.test.ts` is a verification run, not a provisioner: it runs the ten-step suite against the matching runtime revision and Pi version in a private child process with its own fixture `HOME`, XDG directories and temporary directory, copies only Pi's credential and model configuration into that fixture, and removes the fixture — including the readiness record and native sessions it creates — when the run ends. It writes nothing to the user's home, so it leaves no record to install. Never create a success record manually or reuse the scripted worker's test record.

For an existing Service, a paired `POST /api/agents/pi/recheck` reruns the probe; once a record is present, confirm `GET /api/agents` reports Pi `ready`. The image includes the production worker only. Its offline acceptance test mounts a separate scripted worker and proves container wiring rather than real provider authentication or model conformance.

`--shm-size=512m` gives Chromium sufficient shared memory. Chromium's namespace sandbox needs a host that permits unprivileged user namespaces and Docker's `--security-opt seccomp=unconfined`; this relaxes Docker's syscall filtering, so run the Service only with trusted Agent workloads. The browser's own sandbox remains enabled. The image never uses `--privileged`, mounts a desktop socket, or requires a host graphical session.

For remote HTTPS, set `OMARCHY_BOT_HOST` to the interface address you mean (use `0.0.0.0` only when every interface is intended) and mount a readable certificate/key with `OMARCHY_BOT_TLS_CERT` and `OMARCHY_BOT_TLS_KEY`, passing all three as `-e` variables to `docker run`. Alternatively, use `OMARCHY_BOT_TRUSTED_PROXY=<proxy-IP>` behind your TLS-terminating proxy and restrict network access to that proxy. Startup fails on a non-loopback address otherwise. Pairing remains required in both cases. `OMARCHY_BOT_PORT` changes the listener and health probe port. Docker's health check calls `/api/health`; `docker logs` receives Service stdout/stderr and, with TLS enabled and no active Paired Device, the address, code, and `pairing: omarchy-bot://pair?service=…&code=…` deep link the entrypoint issues after the Service reports healthy. An active Paired Device suppresses automatic issuance. `docker exec … pair`, `devices`, and `revoke` use HTTPS with the configured host and port. Wildcard binds connect through loopback and accept local self-signed certificates. For a specific local interface, the CLI binds its source to loopback for host authorization while still validating the destination certificate; install its CA in the image's trust store or use a certificate that verifies. If automatic issuance fails, the entrypoint logs a line saying so; the manual fallback is `docker exec omarchy-bot bun /opt/omarchy-bot/runtime/apps/cli/src/main.ts pair`. Use `docker inspect` for container state/health and `docker logs` for startup failures.

The local health probe sends no credentials and checks liveness only. With HTTPS it skips certificate identity validation so operator-managed self-signed certificates and certificates for the external DNS name still work; validate public TLS separately from container health.

Maintainers can run the real, offline acceptance test with `OMARCHY_BOT_CONTAINER_IMAGE=omarchy-bot:local bun test tests/integration/container-image.test.ts`. It mounts the scripted worker as a test fixture, pairs a client, creates a Bot and Thread, opens a real Bot Screen/browser, then recreates and restarts the container with the same volume and checks browser localStorage, conversations, and the paired token. It removes its private containers and volume on completion.

## Service CLI

`install` and `update` write an executable `omarchy-bot` launcher to `~/.local/bin`, which runs the installed CLI with the recorded data, state, and config paths. It does not change shell startup files or `PATH`: add `~/.local/bin` yourself if your shell does not already include it. Without an install — or from a checkout — invoke the CLI by path:

```bash
bun ~/.local/share/omarchy-bot/runtime/current/apps/cli/src/main.ts <command>
```

Prose elsewhere names the command as `omarchy-bot <command>`; that means the launcher when installed, and this path invocation otherwise. `omarchy-bot --help`, `omarchy-bot help`, `omarchy-bot <command> --help`, and `-h` print usage and exit 0. An unknown or missing command prints `Commands: …` to stderr and exits 2. `uninstall` removes the launcher only if the installer wrote it; a foreign file or symlink at that path makes `install` refuse before touching the runtime or unit.

| Command | Effect |
| :--- | :--- |
| `install --archive <path> --checksum <path> [--no-browser-pack] [--browser-pack <file-or-https-url>]` | Verify the archive, extract into `runtime/current/`, install the browser pack by default (skipped by `--no-browser-pack`), write the launcher, install and enable the user unit, start it, wait for health, print address/code/deep link and open the deep link. Reuses an installed runtime, including its browser pin. Accepts the TLS and proxy flags below. |
| `update --archive <path> --checksum <path> [--no-browser-pack] [--browser-pack <file-or-https-url>]` | Stop the unit, replace `runtime/current/`, refresh the browser pack only when the target runtime's pin changed, the installation is incomplete, or its `browser --version` fails, write the launcher, keep the unit, start it, wait for health, print address/code/deep link and open the deep link. Accepts the TLS and proxy flags below. |
| `reconfigure` | Validate the resulting listener and TLS material, rewrite the unit, reload and restart it, wait for health, and print `Service reconfigured.` Activation failure restores the prior unit and saved settings and restarts the prior Service. The runtime is not replaced; a missing unit or runtime requests `install` first. Accepts only the TLS and proxy flags; `OMARCHY_BOT_BROWSER` in the environment still updates or clears the host browser opt-in. |
| `start` / `stop` | Start or stop `omarchy-bot.service` in the user manager. |
| `status` | Print `state:` (`active`, `failed`, or `inactive`), `address:`, and, when not active, `startup failure:` from the last relevant Service log line. |
| `doctor` | Print one actionable line per failed check, then `All required checks passed.` when nothing but the advisory linger hint is outstanding. Exits 1 if any required check fails. |
| `pair` | Print the Service `address:`, one-time `code:`, and `pairing:` deep link without opening it. |
| `devices` | List Paired Devices as `id<TAB>name`. |
| `revoke <id>` | Revoke one Paired Device. |
| `uninstall` | Disable and stop the unit, remove it, `runtime/`, the owned launcher, and `service.json`, and keep user data. |

`install` and `update` also accept `--browser-pack <file-or-https-url>` and `--no-browser-pack`; combining them, or passing the removed `--with-browser`, is a usage error (exit 2). `OMARCHY_BOT_BROWSER` accepts only `host` or an empty value, and any other value is a usage error. These checks run before anything is written.

`install`, `update`, and `reconfigure` share `[--tls-cert <path> --tls-key <path>] [--trusted-proxy <address>]`, with `OMARCHY_BOT_TLS_CERT`, `OMARCHY_BOT_TLS_KEY`, and `OMARCHY_BOT_TRUSTED_PROXY` as fallbacks. Omitted flags keep the saved configuration. Both certificate flags must be set together; pass `--tls-cert "" --tls-key ""` to disable TLS and `--trusted-proxy ""` to clear proxy trust. Paths become absolute and must contain readable, usable, matching TLS material. The proxy must be one IPv4 or IPv6 address. The resulting listener must retain TLS or a trusted proxy when bound outside loopback; these checks precede unit changes. Existing user or runtime drop-ins that override listener settings (including the former `systemctl --user edit` TLS recipe), reset the environment, or use `EnvironmentFile=` cause an explicit conflict naming the file. Move listener settings to the CLI flags/environment and remove those assignments while preserving unrelated drop-in settings, then retry. The generated unit includes the executing Bun's directory in `PATH`. See [Remote access](#remote-access).

`install` and `update` refuse to run without a systemd user manager; `start`, `stop`, and `uninstall` act on `omarchy-bot.service` in that manager. `status` shells out to `systemctl --user is-active omarchy-bot.service`: with `systemctl` on `PATH` but no reachable user manager it reports `state: inactive` and the last Service log line, while a `PATH` without `systemctl` makes the command fail with exit 1 instead.

`doctor` checks Bun ≥ 1.4, `bash`, `flock`, `systemctl`, `loginctl`, x86_64 Linux, the user manager socket, a lingering hint (`enable lingering: loginctl enable-linger <user>`, advisory), the installed runtime's `serve.sh` and daemon entry, the `.archive-sha256` marker's format, the pinned Sway bundle ready marker, the required font files, the installed browser pack (its pinned ready marker, its executable `browser`, `chrome-linux64/chrome` and `libs/ld-linux-x86-64.so.2`, and a successful `browser --version`), unit presence and active state, an executable launcher, `GET /api/health`, and an unrevoked Paired Device. With `OMARCHY_BOT_BROWSER=host` the pack check is omitted. Failures print one line naming the check, with a repair command where one exists (for example `run omarchy-bot update --archive <path> --checksum <path>`, which repairs the pack from the runtime's recorded release, and for the pack `… --browser-pack <file-or-https-url>` when no release was recorded). It rehashes nothing and never changes the host: the archive digest is checked for format only, and the installed browser binaries are executed but not rehashed, because packaging verifies the pins. Inside a container it reports the missing unit, launcher, and installer-written archive marker by design; use `docker exec … pair` or the pairing URL in `docker logs`.

`pair`, `devices`, `revoke`, and `doctor`'s pairing check read the host secret from `<state>/pairing-host-secret`. They and the `install`/`update`/`reconfigure` health wait use the configured origin, `http://` or `https://` per the installed TLS setting; `status` prints that same address. Wildcard binds connect through loopback. A specific local interface uses a loopback source address so the Service retains its loopback-only host authorization. A self-signed certificate is tolerated only for a loopback destination; interface and remote destination certificates must verify normally, and redirects are refused. Run these commands on the Service Host. For a non-loopback interface with a private CA, configure normal CA trust (for example `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` when invoking Bun), or manage the Service over a loopback listener or tunnel.

CLI environment: `HOME`, `OMARCHY_BOT_HOME`, `OMARCHY_BOT_STATE`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `OMARCHY_BOT_HOST`, `OMARCHY_BOT_PORT`, `OMARCHY_BOT_TLS_CERT`, `OMARCHY_BOT_TLS_KEY`, `OMARCHY_BOT_TRUSTED_PROXY`, `OMARCHY_BOT_BROWSER`, `OMARCHY_BOT_OPEN`, `PATH`, and `USER`. Values saved in `<dataDir>/service.json` supply the connection settings that are not set in the environment; the saved listener is the effective one (`127.0.0.1:7321` when nothing was supplied).

## Product model

**A Bot is a teammate. An Agent is its execution backend.** Each Bot references one immutable Agent; several Bots may use the same Agent. Adapters preserve native capabilities and approval behavior, rather than adding a separate permission policy or capability allowlist.

```text
                         Bot Client · Web
                                |
                       Service (Bun + SQLite)
                      /         |          \
                 Threads     Agent workers  Computer Broker
                 SQLite         Pi                |
                                      One private Bot Computer
                                      Shared Sway + app profile
                                         /               \
                                    Bot A Screen     Bot B Screen

               Shared Workspace · common work files for all Bots
```

- **One Bot Computer, multiple Bot Screens.** Each active Screen owns an output and workspace in a shared, pure-headless Sway runtime. Screens do not own separate compositors, browser profiles, or input seats.
- **Tabbed Bot Screens.** Each workspace shows one full-width application with readable titles for the other open windows. Dialogs and file pickers float centered above the application.
- **Coordinated desktop input.** The runtime serializes actions across Screens. Human Web Control holds the shared input seat until control is returned; background applications can continue running.
- **Structure-first browser control.** Agents operate the visible pack browser through a `browser` tool: a snapshot of the accessibility tree with Element Refs, then clicks, typing, and selection delivered as real input on this Screen. Screenshots and raw input remain the fallback for canvases and anything the tree does not describe. CAPTCHAs, anti-bot challenges, logins, and payment are handed to the user through Takeover with a visible reason; a Bot never tries to solve or bypass them. The `OMARCHY_BOT_BROWSER=host` opt-in remains `computer`-only, because a host browser has no Service-owned pipe.
- **Viewing is not execution.** Closing a viewer does not stop the Screen's applications. WayVNC supplies on-demand, view-only RFB projection; Computer Broker remains the input authority.
- **Work files outlive a Bot.** Deleting a Bot removes its Service-owned data and targeted Screen runtime/workspace, not Shared Workspace files, Agent-owned Native Sessions, or the shared Bot Computer profile.

The accepted [product specification](docs/workspace-redesign.md), [shared Bot Computer decision](docs/adr/0009-share-work-files-isolate-bot-screens.md), and [domain context map](CONTEXT-MAP.md) define the boundaries.

### Dictation

Focus the Composer and use dictation on your own device. The operating system types the transcript into the draft; review or edit it, then send normally. The Service never captures microphone audio.

- **macOS:** press the Dictation key or your configured Dictation shortcut (commonly `Fn` / Globe twice); enable or change it in System Settings → Keyboard → Dictation.
- **Windows:** press `Win+H`.
- **Omarchy:** use Voxtype with `Super+Ctrl+X` to toggle dictation, or hold `F9` to talk and release to finish.
- **Phones:** use the microphone key on the on-screen keyboard.


## Status

The current implementation includes a Bun daemon, React web client, SQLite persistence, and isolated Agent workers. Shared Sway runtime, routed Screens, shared application state, and selected-view projection are implemented.

**Host Session acceptance remains open.** Automated real-Sway conformance covers two routed Screens, shared profile/runtime markers, Agent control, projection, URL reuse, deletion/reprovision, and host environment isolation. It does not prove the user's top bar, shortcuts, or ordinary physical-input experience. See the [runtime decision and evidence](docs/contexts/computer-control/adr/0009-adopt-sway-bot-desktops.md).

Omarchy Bot at `apps/omarchy-bot` embeds the production Web UI in a thin Tauri 2 Linux shell. Execution stays in the Service ([ADR 0010](docs/adr/0010-reuse-web-client-in-tauri.md), [ADR 0015](docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md)). Its packaged WebKitGTK smoke suite covers pairing, persistence, network policy, the event stream, Screen Projection, and Takeover. Chromium tests remain shared UI coverage.

The Local Sidecar connects outbound using `OMARCHY_BOT_SERVICE_URL` (`ws://…` or `wss://…`), `OMARCHY_BOT_DEVICE_ID` (`dev_<32hex>`), `OMARCHY_BOT_DEVICE_TOKEN` (the Paired Device token), and `OMARCHY_BOT_SIDECAR_ROOT`; `OMARCHY_BOT_HOSTNAME` is optional. TLS uses the operating system's trusted certificates, with no certificate bypass. Registration requires its OS (`linux`, `macos`, `windows`) and shell (`posix-sh`, `powershell-5.1`); the roster and each Turn's `local` tool description carry the sender's identity. Linux and macOS execute POSIX `sh` commands with process-group teardown; Windows executes Windows PowerShell 5.1 commands assigned to a Job Object before user code runs. Cancel and timeout terminate the command tree on every OS. File operations and search refuse `.ssh`, `.gnupg`, `.aws`, and `.config`; macOS additionally refuses `Library/Keychains`, `Library/Accounts`, and `Library/Application Support/com.apple.TCC`, while Windows additionally refuses Credentials, Protect, Vault, and Crypto under both `AppData/Local/Microsoft` and `AppData/Roaming/Microsoft`. Windows checks ignore case and expand existing NTFS short aliases, including ancestors of new write destinations. Screenshot, pointer, and compositor requests remain refused on every OS. The client tags each send with its Sidecar identity so the Service resolves **This Device** only from that Turn's sender; untagged, unknown, and offline senders never borrow another Sidecar. See [ADR 0015](docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md) and [the device identity contract](docs/adr/0011-local-sidecar-only-off-host.md#client-side-device-identity).

The Web UI reads native capabilities through one six-capability `shell` interface: Service connection, pairing intake, system browser, updates, Local Sidecar, and key mapping. The Linux app installs its native adapter before the Web bundle loads; the Vite harness and Chromium tests use the memory adapter. For an off-host Service, the app starts its bundled compiled Sidecar with a cryptographically generated, persisted `dev_<32hex>` identity. Every send carries that identity while the Sidecar is registered, so the Service resolves **This Device** to the same install. Approval cards show the exact command or path; Always/Never policies live in the install's app-local data and survive restart and re-pairing. Quit, unpair, re-pair and child disconnection stop the Sidecar; the Service fails pending local jobs. Loopback Services (`localhost`, IPv4 loopback and IPv6 loopback) start no Sidecar. This address-only detector also suppresses a remote Service reached through an SSH tunnel to loopback, and treats a same-machine Service reached through a non-loopback address as off-host. Signed updates remain ticket 11. See [ADR 0015](docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md) and [ADR 0011](docs/adr/0011-local-sidecar-only-off-host.md#client-side-device-identity).

On macOS, Web Control maps ⌘ to Ctrl and ⌥ to Super. Settings → Keyboard → “Send ⌘ as Super” changes Command for this device; Option still sends Super. The shell stores the preference independently of the paired Service, so unpairing does not reset it. The Vite memory shell detects the browser platform and persists the preference in that harness origin’s localStorage; the native app adapter owns its install’s storage. Linux and Windows keep their existing key handling. ⌘V and Ctrl+V retain the local plain-text paste path rather than forwarding a remote V key.

## Development

From a local checkout:

```bash
bun install
OMARCHY_BOT_DEV=1 bun run dev
```

Open **<http://127.0.0.1:7322>**. Vite serves the developer harness; the memory shell connects directly across origins to the Service, including HTTP, events, attachments, and Screen Projection. There is no API proxy. Issue a pairing code on the Service Host with `omarchy-bot pair`, then enter the printed address and code in Add Service. The memory shell stores the paired connection in that harness origin's localStorage; this is development persistence, while the app adapter owns keychain storage. Shell pairing intake accepts the same Service address and code without typing. A 401 clears the connection, stops event delivery, and returns to Add Service with a revoked-device message. The Service serves no static UI, single-page fallback, or `/pair` page, and its runtime archive excludes `apps/web/dist`.

The Service allows CORS and WebSocket connections from the app's fixed origins: `tauri://localhost`, `http://tauri.localhost`, and `https://tauri.localhost`. Set `OMARCHY_BOT_DEV=1` on the Service process to also allow HTTP development origins at exactly `localhost`, `127.0.0.1`, or `[::1]`, with any valid port. This opt-in defaults off and is not written into installed Service units. Preflight needs no token; actual API requests and WebSocket upgrades still require a Paired Device token in the `Authorization: Bearer` header or `access_token` query parameter. CORS never allows credentials (cookies). WebSockets without an Origin, such as the Local Sidecar, follow normal token authentication; foreign Origins are refused before authentication.

### Linux application

Build and exercise the packaged x86_64 AppImage with Docker, without installing Rust, WebKitGTK, or a display server on the host:

```bash
bun install --frozen-lockfile
bash scripts/build-linux-app.sh
bash scripts/smoke-linux-app.sh .lane/dist/omarchy-bot_0.1.0_amd64.AppImage
```

The container owns the toolchain, private display, D-Bus, keyring, and app profile. The smoke suite drives the shipped artifact with `tauri-driver` and WebKitWebDriver. Build and smoke details are in [scripts/linux-app/README.md](scripts/linux-app/README.md). The Service runtime archive excludes the native app.

On first launch, enter the Service address and one-time code in **Add Service**, or open the Service-issued `omarchy-bot://pair?service=…&code=…` link. A running instance receives later links in its existing window. The address must be an HTTPS origin, or HTTP on loopback for an SSH tunnel. Links with credentials, paths, duplicate parameters, or non-loopback plaintext are refused. URL-scheme desktop integration is handled by the installer; the AppImage also accepts the deep link as its argument.

The Service address and token are stored together in the operating system Secret Service keychain (`service=com.omarchy.bot`, `username=service-connection`), never in WebView storage. An unavailable or locked keyring shows an actionable error; the app keeps existing credentials. Unlock the keyring and reopen the app to retry. Revocation clears the keychain entry and retains only the nonsecret Service address in the app configuration directory when writable, so Add Service keeps its explanation and address across restart until pairing succeeds. A notice-write failure never blocks credential removal. Keyboard preferences remain separate.

Pairing and clearing the connection restart the app once to apply its network policy. Before pairing, CSP permits HTTP/HTTPS for the exchange; address validation rejects non-loopback plaintext before sending the code. After restart, Service HTTP/WebSocket and image access are restricted to the paired origin. An explicit pairing link for another Service reopens Add Service before exchange and retains the old keychain entry until the new token is stored. Embedded navigation stays inside the app, and external HTTP/HTTPS links open through the system-browser shell capability. An untrusted certificate shows a TLS-specific error; no certificate bypass is available. The single-instance desktop plugin is isolated in the native shell; the shared Web UI imports no native plugin.

Conversation and plugin documentation links use the system browser. Clicking a managed file attachment downloads its authenticated bytes through the paired WebView connection and saves them in Downloads, preserving the filename and adding a prefix if it already exists. The app displays the saved path; its window stays on the conversation and the device token is never sent to the external browser. Certificate errors are explained both during pairing and when reopening an existing HTTPS connection.

### Official website

The public product site lives in `apps/site`, separate from the local Bot Client.
It remains a Vite + TypeScript frontend with native CSS. The full-viewport pixel
field, Omarchy wordmark artwork, and 22 named palettes are adapted from
[the Omarchy website](https://github.com/omacom/omarchy-site/tree/47711270650b9c78c7bfa996cdd0b6050c79566f),
with Matte Black as the default. The Canvas renderer shares the wordmark's grid,
supports pointer glow and click stamps, pauses when offscreen or hidden, and
honors reduced motion and an explicit pause control. Product screenshots remain
below the first screen. Radio and etch-effect integrations are not included.
The hero extends the original 81-by-19 artwork with matching BOT lettering on a
117-by-19 grid, shared by Canvas and the no-JavaScript SVG fallback.
Upstream-derived portions are attributed separately in
[`apps/site/public/UPSTREAM-NOTICE.txt`](apps/site/public/UPSTREAM-NOTICE.txt)
and are not relicensed under this project's MIT license. JetBrains Mono and
Geist are self-hosted with their font licenses in `apps/site/public/fonts`.

The public pages make no daemon connections or model calls. Product screenshots
use illustrative data. The same Vercel project includes server-side plugin OAuth
and Skills catalog routes. Default Skills access is ready to use; service
authorization still requires publisher configuration.

```bash
bun run site:dev   # http://127.0.0.1:7330
bun run site:build # apps/site/dist
```

For Vercel, import the repository and set **Root Directory** to `apps/site`.
Enable access to source files outside that directory for the Bun workspace
installation. `apps/site/vercel.json` sets the install command, build command,
static output directory, and response headers. Deployment requires a signed-in
Vercel account; the repository does not contain deployment credentials.
Install and build commands use `bunx bun@1.4.2` so Vercel's preinstalled Bun does
not need to support the repository's v2 lockfile. Keep the frozen-lockfile check
enabled; do not regenerate dependency resolutions to work around an older build image.
The production hostname supplied by Vercel generates canonical and social-image
URLs; set `SITE_URL` to the final HTTPS origin when using a custom domain.
Vite previews the public pages only; OAuth and catalog functions run on Vercel.

### Global plugins

Open **Plugins** above **Settings** in the Bot Client sidebar. It opens a large
dialog on desktop and a tall sheet on mobile without navigating away from the
current conversation or discarding its draft.
Shared MCP configuration, Skills, and connected service accounts serve all Bots.
Effective availability follows the Agent's native discovery and session/extension
reload lifecycle, not an unconditional next-Turn snapshot. Native Skill files
remain mutable; there is no blanket per-Turn immutable revision lease. Disabling
or removing a resource applies at the applicable native boundary without killing
unrelated Turns. Provider-side revocation can still interrupt a running call.

- **MCP:** custom project configuration is reconciled across `.mcp.json`,
  `.pi/mcp.json`, and `.codex/config.toml`, preserving unrelated/client-specific
  settings and reporting conflicts and unsupported fields instead of overwriting
  them. Transport support and limits depend on the native client. Pi business MCP
  calls run only through pinned `pi-mcp-adapter@2.33.0`, not daemon-injected tools.
  Environment variables and HTTP headers remain write-only in the Client.
  Choose an explicit **public npm package** to let Omarchy Bot own its private
  installation and updates, or supply a native stdio command or HTTP endpoint.
  Managed packages use an exact npm name without a version suffix, an optional
  binary name, arguments, and write-only environment variables; installation and
  updates resolve npm `latest`. **Node 24+ on PATH is required** for managed package
  entrypoints; Node is also used by the Linux/Bun native OAuth OS-lock helper. Packages requiring
  install-time scripts or non-Node entrypoints are unsupported. No host installation
  or global package update is attempted.
  Clean managed installations update at a safe native lifecycle boundary; local
  modifications block replacement, and failed updates preserve the prior usable
  version. Installed/available versions and update attention remain visible.
  Active Turns are not forcibly terminated to update a package, and obsolete
  native processes are released only when safe. Existing opaque stdio commands
  remain first-class native inputs, never inferred package ownership or upgraded
  by the product. Hosted MCP deployments remain provider-controlled.
- **Skills:** search the formal skills.sh catalog, inspect, install, enable, and
  remove without configuring a backend. Remote updates preserve local edits and
  report conflicts. Installations include companion files, not only `SKILL.md`.
  Canonical shared Skills live at `~/.omarchy-bot/workspace/.agents/skills`,
  with native client discovery links where needed. Pi uses native discovery;
  type `/` in the composer to select a Skill.
  If an entry no longer identifies a Skill in its source repository, installation
  fails rather than guessing a replacement.
  **Discover** shows a paginated card catalog; **Installed** counts shared Skills
  (including disabled ones), without Agent badges. Other discovered resources
  remain read-only in a separate section and are not counted as shared installs.
  Browsing uses server-side pages of 12. Search retrieves up to 200 matches once
  and pages the cached results locally, with an explicit limit notice.
- **Services:** search by name, provider, description, or category. Category tabs
  and grouped browsing share the same filter; returning from a Service preserves
  the search and category. **Connected** includes only Services with a connected
  native component, not merely an account grant awaiting authorization.
  Services share a provider account pool and support multiple accounts. Each
  groups only its official MCP connections and published companion Skills;
  there is no REST business fallback. Provider-specific
  setup, account eligibility, consent, and separate external-client login still
  apply. See the [provider endpoints and setup references](packages/protocol/src/pluginProviders.ts).
  **Add account** and **Reconnect** open provider consent in the system browser.
  The OAuth callback stays on the Service and offers an `omarchy-bot://` link
  back to Omarchy Bot. Completion and failure refresh plugin state in every
  connected app through the event stream; a failed or cancelled attempt can
  be retried with **Add account** or **Reconnect**. Authorization requests carry
  no client return URL.
- **Create a Skill:** the [official OpenAI Skill Creator](https://github.com/openai/skills/tree/main/skills/.system/skill-creator),
  its complete resources, and vendored PyYAML are supplied locally. Ordinary
  Python 3 is required; Pi creation needs no Codex/Claude installation or
  credentials. Bots use native file/execution tools to create shared local files,
  without publication, registration, or a separate authoring service.
  In **Plugins → Skills**, **Create skill** is visible in both Discover and
  Installed. Describe the behavior and choose a Bot; **Start creation** sends
  the request through the normal Bot message API in a new conversation, leaving
  existing Threads and drafts unchanged. Missing or disabled Creator resources
  are shown explicitly rather than pretending creation is ready. A daemon still
  running an older build must be restarted to load newly bundled resources.

Externally configured and user-level resources retain native precedence and are
read-only in this panel; shared project files are the editable configuration
surface. Credentials stay in private application/native-client stores, never
shared files or model-visible output. Application plugin directories use mode
`0700` and private configuration uses `0600`. **Tokens are not encrypted at rest.**
The publisher exchanges codes and refresh tokens but does not persist accounts.
Installed Skills and stdio MCP servers are trusted local code, not a sandbox.
The existing plugin Tool Call bridge manages inventory and configuration; it is
not a second MCP runtime. See the [native plugin specification](.scratch/shared-plugins-native-discovery/spec.md)
and [adapter boundary](docs/agents-integration.md#native-plugin-discovery-and-runtime).
Acceptance exercised Pi SDK 0.84.4 with `pi-mcp-adapter@2.33.0`, real stdio and
HTTP tools, controlled native PKCE authorization, packaged daemon startup and
Creator execution, and desktop/narrow Chromium. Codex 0.154.0 discovered the same
shared Skill files and custom MCP configuration. Live provider consent/business
access, native Claude/Codex model authoring, and Tauri/WebView compatibility remain
unverified; see the [acceptance record](.scratch/shared-plugins-native-discovery/issues/16-installed-plugin-upgrade-and-recovery.md).

The composer uses Astryx's native slash-trigger menu. The pinned
`@astryxdesign/core@0.5.2` patch removes the unsupported `aria-multiline` attribute
when that input is a combobox; Bun applies it during installation, and runtime
archives include the patch. Reassess it when upgrading Astryx.

The Message input is a combobox while Skill commands are available, and a
textbox for multiword drafts, offline Agents, and active Turns. End-to-end tests
combine both roles with the exact accessible name so the same locator survives
typing and sending; a dedicated test verifies the owned Skill commands listbox.

#### Publisher deployment (maintainers)

Clients use `https://omarchy-bot-site-ymlq.vercel.app` automatically. Both new
installations and existing configurations without an override use this default.
The Bot Client does not expose publisher configuration. For self-hosted
installations, operators can use the daemon's `PUT /api/plugins/settings`
endpoint with an HTTPS `cloudUrl`; `null` restores the default.

The Skills catalog uses Vercel OIDC and does not require service OAuth secrets.
For service authorization, configure the publisher's server-side environment:

- `PLUGIN_CLOUD_URL` or `SITE_URL`: the deployed HTTPS origin.
- `OAUTH_STATE_SECRET`: a random secret of at least 32 bytes.
- `OAUTH_<PROVIDER>_CLIENT_ID` and `OAUTH_<PROVIDER>_CLIENT_SECRET` for each
  registered provider (uppercase provider ID, such as `GOOGLE` or `MICROSOFT`).
  Notion uses its public Client ID Metadata Document instead of a client secret.
- Enable Vercel OIDC for the formal skills.sh API. OIDC credentials and OAuth
  client secrets stay on the publisher; do not distribute them to Clients.

Register `<origin>/api/plugins/oauth/callback` as each app's OAuth redirect URI.
Notion's metadata document is `<origin>/api/plugins/oauth/client/notion`.
Provider registration is not interchangeable: Google needs the relevant Workspace
APIs and scope review; Microsoft needs delegated Graph permissions and the desired
personal/organization account audience; Asana and HubSpot require their MCP app
configuration. Register the required GitHub, Linear, Dropbox, Intercom, and Miro
apps and permissions as described by each provider's linked setup notes.
Google's public verification also requires a verified domain, accurate homepage
and privacy disclosures, and review of restricted data sent to model providers;
keeping tokens local does not by itself establish a security-assessment exemption.
Intercom's Australian region is not supported by its MCP service.

No production registrations, provider credentials, or live connected accounts are
included. The repository's fixture-backed OAuth checks do not establish live
provider compatibility or completed app reviews. Deploy and authorize real
accounts before presenting these connectors as publicly available.

### Requirements

| Dependency | Used for |
| :--- | :--- |
| **Bun 1.4+** | Workspace dependencies, Service, CLI, and development commands |
| **Bash and `flock`** | `scripts/serve.sh` and the Omarchy plugin entry script |
| **systemd user manager** | `install`, `start`, `stop`, and `uninstall`, plus the manager socket `$XDG_RUNTIME_DIR/systemd/private`; `status` needs the `systemctl` binary and reads a stopped manager as `inactive` |
| **`curl` and `unzip`** | Omarchy plugin runtime download and container image asset preparation |
| **Configured Pi installation** | Real Agent execution and Pi conformance |
| **Docker** | Building the container image and running its conformance |
| **Network during `install`/`update`** | Downloads the checksum-verified browser pack (Chrome for Testing plus its libraries) unless `--no-browser-pack` is passed; the Bot Computer never downloads at run time, and fonts ship inside the runtime archive |

On first graphical use, the Service uses the SHA-256-pinned Bot Computer bundle shipped inside its runtime archive under `<dataDir>/runtime/current/sway`. It contains Sway, wlroots, WayVNC, wlr-randr, Xwayland, grim, a private D-Bus daemon, and prebuilt capture/input/desktop helpers with their loader, libraries, and runtime data. The same archive runs on glibc and musl x86_64 Linux hosts; host grim, D-Bus, and a C toolchain are unnecessary. Point `OMARCHY_BOT_SWAY_BUNDLE_DIR` at the checksum-prepared `.lane/dist/sway` directory output by `bash scripts/build-sway-runtime.sh .lane/dist` to develop against a local bundle, and explicit binary overrides remain available.

The bundled `dbus-daemon` launcher defaults to its private `share/dbus-1/session.conf`; a caller-supplied `--config-file` takes precedence so the Bot Computer can use its own session configuration.

When runtime fonts are configured, the Service verifies them before starting Sway and passes their private fontconfig file to the compositor as well as applications, so tab titles render on hosts with no fonts installed.

Maintainers build the pinned sources and verify the resulting library closure with `bash scripts/build-sway-runtime.sh .lane/dist`, which writes the archive, its `.sha256`, and the checksum-prepared development directory `.lane/dist/sway`. Run `sh scripts/sway-runtime/conformance/run.sh <archive.tar.gz> [font-dir]` for bundle-only Ubuntu 22.04 Bot Screen conformance and an Alpine loader smoke check; without the optional font directory it prepares `.lane/fonts` with `bash scripts/prepare-fonts.sh .lane/fonts`, which needs network access. CI requires the built archive to match the checksum in `swayRuntimeSupply.ts`, and packaging embeds that verified bundle plus checksum-verified fonts in the runtime archive:

```bash
bash scripts/prepare-fonts.sh .lane/fonts
bash scripts/package-plugin-runtime.sh . dist-runtime <archive.tar.gz> .lane/fonts
```

The fourth argument (or `OMARCHY_BOT_FONT_ASSETS_DIR`) is required; packaging refuses to run without a font directory whose files match the pinned `FONT_ASSETS` checksums. No separate Sway release is published.

Packaging stores hardlinked dependency files as independent regular files while preserving symlinks. This keeps archives compatible with the installer's strict file, directory, and symlink allowlist; hardlink entries remain rejected during extraction.

The browser pack is a second artifact built from the same pins:

```bash
bash scripts/package-browser-pack.sh "$PWD" .lane/browser-pack
```

It reads `BROWSER_ASSET` and `BROWSER_LIBRARY_ASSETS` from `botComputerAssets.ts`, verifies every input's SHA-256, and writes `omarchy-bot-browser-<version>-x86_64.tar.zst` with a `.sha256` sidecar; `<version>` is the pinned `BROWSER_ASSETS_RELEASE`. It refuses a mismatched input and writes no archive. The optional third argument is a directory of already-downloaded inputs named by their SHA-256, which is how CI and the container build reuse a cache; without it the builder downloads the pinned inputs into `<out-dir>/inputs`. `plugin-runtime.yml` uploads the pack beside the runtime archive and publishes both in the same `runtime-<sha>` release.

The `distro-conformance` pull-request/manual workflow builds the same runtime archive and browser pack without publishing either, then runs named jobs for Ubuntu 22.04/24.04, Debian 12, Fedora, Arch, openSUSE, and Alpine. Each installs the checksum-verified archive with the shared CLI extraction code, installs the browser pack into the container, and starts `scripts/serve.sh` under a container entrypoint (including Alpine's non-systemd path). A paired scripted Agent opens a real Screen, captures PNGs, opens a local page in the portable browser, and types text that the page reports back. Seam 3 runs the bundle/Xwayland/isolation suite, the tabbed-layout/dialog suite, and the portable-browser/CJK/shared-profile/snap-avoidance suite against that installed archive. The containers run with `--network none`, so a browser or library that still needed a download would fail the job. Sway always uses headless pixman; no host compositor, display socket, GPU, systemd manager, or host configuration is mounted.

The `sidecar-conformance` pull-request/manual workflow runs the Local Sidecar executor and policy suite on Linux, macOS, and Windows, compiles a native binary on each runner, and exercises registration, approved execution, each OS's credential denylist, descendant cancellation, and authenticated TLS against that binary over the WebSocket and approval-stdio contracts. The TLS fixture uses the runner's OpenSSL (including Git for Windows), trusts only its temporary certificate for the successful connection, and also checks untrusted and unpaired rejection. Windows uses Windows PowerShell 5.1 with text output and assigns each command to a kill-on-close Job Object before releasing its script through stdin; cancellation and timeout stop the whole tree. File operations and search refuse the per-OS credential directories. On Windows this includes Credentials, Protect, Vault, and Crypto under both `AppData/Local/Microsoft` and `AppData/Roaming/Microsoft`, ignoring case and expanding existing NTFS short aliases, including ancestors of new write paths. The Windows alias regression requires a real 8.3 alias on the test volume and fails if the fixture cannot witness one. The Linux-only Service integration harness remains in the Linux suite.

PowerShell results preserve an explicit `exit` code, otherwise a nonzero last native-program exit code, otherwise the final script command's success or failure. Status is captured inside the executed script so a final `Write-Error` or missing command returns 1 even after a native command returned 0. PowerShell's native parser locates the final execution block, preserving top-level named blocks, parameters, directives, and comments; the completion path stays in the bootstrap's script scope so a user `$completion` variable cannot redirect its write. Portable PowerShell 7 on Linux can exercise the bootstrap, stdin gate, text output, token stripping, and truncation; Windows PowerShell 5.1, Job Objects, NTFS aliases, and the compiled Windows process still require a real Windows runner.

PowerShell first-use progress is suppressed before module activity; framed CLIXML warnings and errors are decoded to readable text. Each Windows job captures output in private temporary files, so an application's incidental inherited handles cannot hold completion open. After natural script return, the result includes output flushed through root-process exit and the launched application survives; later application output is outside that result. An explicit `exit` bypasses the normal-return marker and keeps remaining descendants in the cancellable job until they exit. Portable checks also exercise normal-return markers and a child retaining inherited output files; Windows handle inheritance, Job Object accounting, and temporary-file cleanup still require the Windows CI rerun.

To repeat one job locally, prepare its image explicitly and supply a runtime archive plus its `.sha256` sidecar, and the browser pack:

```bash
# Docker, Bun 1.4+, a cached base image, and network for image prerequisites are required.
# Replace the id with any entry in scripts/distro-conformance/matrix.json.
OMARCHY_BOT_DISTRO_BUILD=1 bun scripts/distro-conformance/run.ts ubuntu-22.04 /path/to/runtime.tar.zst /path/to/omarchy-bot-browser-<version>-x86_64.tar.zst
# Reuse the prepared image without pulling or rebuilding:
bun scripts/distro-conformance/run.ts ubuntu-22.04 /path/to/runtime.tar.zst /path/to/omarchy-bot-browser-<version>-x86_64.tar.zst
```

The browser pack argument is required; the runner verifies each input's adjacent `.sha256` sidecar and mounts both read-only. To make the pack once, run `bash scripts/package-browser-pack.sh "$PWD" .lane/browser-pack` and use the archive it prints.

The image provides Bash, Bun (the native musl build on Alpine), `flock`, and development files only for the X11/Wayland test clients. The application and production dependencies come from the archive and the browser from the installed pack; tests never reinstall or download either. Containers run with `--network none`, so an unexpectedly missing prerequisite fails explicitly instead of silently downloading. Runs use read-only inputs, a private temporary home/runtime/profile, no host ports or Docker volumes, and `--rm --init` for targeted process cleanup. The production CLI's systemd lifecycle is covered separately by installer fixtures; this matrix exercises the documented unpacked-runtime/container Launcher path.

The test container relaxes Docker's seccomp profile so Chromium can create its own user-namespace sandbox; it still runs as uid 1000 without privileged mode or host devices. Hosts that disable unprivileged user namespaces must enable them in their container/CI environment before browser conformance can pass; the runner does not change host sysctls or disable Chromium's sandbox.

The Bot Computer also supplies its own browser and fonts, so `open_url` works on a Service Host with no browser and pages render Latin and CJK text without host fonts. The Service launches the browser from the installed **browser pack** — Chrome for Testing plus its pinned Ubuntu library closure — under `<dataDir>/runtime/browser`, with `OMARCHY_BOT_BROWSER_PACK_DIR` as the development override. The pack is the default on every host because it is one pinned version for Agent control and needs nothing from the host; it is never installed on the host, and every Screen shares the one browser profile so sign-ins and session state carry over. The runtime archive stays browserless: `install` and `update` add the pack by default, `--no-browser-pack` skips it, and `uninstall` removes it. A host browser is used only with the explicit opt-in `OMARCHY_BOT_BROWSER=host`; snap-confined browsers are never launched, because a snap cannot see the Bot Computer's private home. The Service never downloads a browser; with neither an installed pack nor a usable opted-in host browser, `open_url` fails with one message: `No installed browser pack. Run omarchy-bot update --archive <path> --checksum <path> --browser-pack <file-or-https-url>, or set OMARCHY_BOT_BROWSER=host to use a host browser.` The fonts ship inside the runtime archive at `<dataDir>/runtime/current/fonts`, and `OMARCHY_BOT_FONT_DIR` points at a locally prepared font directory for development. Each `open_url` opens a new window routed to the requesting Screen. The pack launches with a normal Wayland window and a fixed flag set that contains no headless, automation, or remote-debugging flags; a host browser under the opt-in launches through its own desktop entry. Chrome for Testing ships no Widevine module, so DRM-protected video does not play; other pages render normally.

### Useful checks

```bash
bun run typecheck
bun test
bun run build
```

Workspace visual checks run with `bun run test:e2e 13-responsive-accessible-visual-qa.spec.ts`.
They use fixed fixtures, viewports, themes, and the installed Playwright Chromium.
The capture helper also pauses native DiceBear animations inside SVG image data
URIs: page-level animation controls cannot freeze those separate image documents.
Avatars remain visible, normal-motion media stays enabled for its cases, and the
reduced-motion case asserts the product's static working avatar before capture.
Review snapshot differences before updating; browser and system-font changes can
still affect raster output.

Real Pi conformance makes model calls and requires a configured Agent. It runs in a private child process with fixture `HOME`/XDG directories, temporary copies of Pi's credential and model configuration, and removes the fixture — record and native sessions included — on completion. It needs the same prepared Sway bundle, font directory, and browser pack as the portable-browser run below, provided through `OMARCHY_BOT_SWAY_BUNDLE_DIR`, `OMARCHY_BOT_FONT_DIR`, and `OMARCHY_BOT_BROWSER_PACK_DIR` (or the individual binary overrides); its final step opens a loopback form in the pack browser, snapshots it, fills it by Element Ref, and reads the submitted receipt back:

```bash
bun test tests/conformance/pi.test.ts
```

Real portable-browser conformance runs one private Sway Bot Computer on a fixture host with no browser on `PATH` and no visible host desktop entries, captures a Latin/Chinese/Japanese/Korean page from two Screens, and asserts real glyphs rather than empty boxes, one shared browser profile, and no snap launch. It runs that scenario with the pack as the default selection and again with `OMARCHY_BOT_BROWSER=host`. It needs a prepared Sway bundle, a prepared font directory, and an installed browser pack (pointed at with `OMARCHY_BOT_BROWSER_PACK_DIR`), and skips without the flag. Prepare all three once (the bundle build needs Docker; the pack build downloads the pinned Chrome for Testing and library inputs over HTTPS):

```bash
bash scripts/build-sway-runtime.sh .lane/dist    # writes .lane/dist/sway with relocatable launchers
bash scripts/prepare-fonts.sh .lane/fonts
bash scripts/package-browser-pack.sh "$PWD" .lane/browser-pack
bun scripts/install-browser-pack.ts .lane/browser-pack/*.tar.zst .lane/browser
```

Each bundle launcher relocates from its own path, so pointing the variables at `.lane/dist/sway/bin` runs no host compiler and needs no host Sway, grim, or D-Bus:

```bash
sway=$PWD/.lane/dist/sway
OMARCHY_BOT_REAL_PORTABLE_BROWSER=1 \
OMARCHY_BOT_SWAY_BIN=$sway/bin/sway \
OMARCHY_BOT_SWAYMSG_BIN=$sway/bin/swaymsg \
OMARCHY_BOT_WLR_RANDR_BIN=$sway/bin/wlr-randr \
OMARCHY_BOT_WAYVNC_BIN=$sway/bin/wayvnc \
OMARCHY_BOT_GRIM_BIN=$sway/bin/grim \
OMARCHY_BOT_DBUS_DAEMON_BIN=$sway/bin/dbus-daemon \
OMARCHY_BOT_INPUT_HELPER_BIN=$sway/bin/omarchy-bot-wayland-input \
OMARCHY_BOT_CAPTURE_HELPER_BIN=$sway/bin/omarchy-bot-wayland-capture \
OMARCHY_BOT_DESKTOP_BIN=$sway/bin/omarchy-bot-desktop \
OMARCHY_BOT_FONT_DIR=$PWD/.lane/fonts \
OMARCHY_BOT_BROWSER_PACK_DIR=$PWD/.lane/browser \
bun test tests/integration/bot-screen-portable-browser-conformance.test.ts
```

`OMARCHY_BOT_SWAY_BIN` and `OMARCHY_BOT_WLR_RANDR_BIN` are required; `grim` and `dbus-daemon` come from `OMARCHY_BOT_GRIM_BIN` and `OMARCHY_BOT_DBUS_DAEMON_BIN` or from `PATH`. The three helper overrides avoid building the native helpers from source; without them the test compiles them, which needs a C toolchain and Wayland development files.

Real browser-tool conformance drives the same pack through the `browser` tool in one private Sway Bot Computer. It opens a loopback form, asserts snapshot refs and a stale-ref failure, types and selects through real input, waits for and reads the submitted receipt, samples page-side neutrality signals including `navigator.webdriver`, checks the browser process tree owns no TCP listener, keeps two Screens' tabs separate, and holds an agent-requested Takeover with its reason until “I'm done” returns a fresh snapshot. It needs the same bundle, font directory, and pack, and skips without the flag:

```bash
sway=$PWD/.lane/dist/sway
OMARCHY_BOT_REAL_PORTABLE_BROWSER=1 \
OMARCHY_BOT_SWAY_BIN=$sway/bin/sway \
OMARCHY_BOT_SWAYMSG_BIN=$sway/bin/swaymsg \
OMARCHY_BOT_WLR_RANDR_BIN=$sway/bin/wlr-randr \
OMARCHY_BOT_WAYVNC_BIN=$sway/bin/wayvnc \
OMARCHY_BOT_GRIM_BIN=$sway/bin/grim \
OMARCHY_BOT_DBUS_DAEMON_BIN=$sway/bin/dbus-daemon \
OMARCHY_BOT_INPUT_HELPER_BIN=$sway/bin/omarchy-bot-wayland-input \
OMARCHY_BOT_CAPTURE_HELPER_BIN=$sway/bin/omarchy-bot-wayland-capture \
OMARCHY_BOT_DESKTOP_BIN=$sway/bin/omarchy-bot-desktop \
OMARCHY_BOT_FONT_DIR=$PWD/.lane/fonts \
OMARCHY_BOT_BROWSER_PACK_DIR=$PWD/.lane/browser \
bun test tests/integration/browser-real-conformance.test.ts
```

## Bot-to-Bot mail

Create two Bots. Select the target and copy its stable `bot_…` ID from the `bot` query parameter in the browser URL. Ask the source Bot to call its native tool once:

```text
Use send_bot_message with targetBotId "bot_0123456789abcdef0123456789abcdef"
and text "Review the release checklist." Then conclude without waiting.
```

**Send → durable queue → target-owned Thread → target response.**

A successful Tool Call acknowledges the queued delivery, not the target's eventual output. The target gains ordinary unread attention and runs later with its own current Instructions, the sender attribution, and the delivered text.

Mail does not forward the source Thread, Native Session, memory, attachments, or filesystem paths. This is a message boundary, not filesystem isolation: Bots still share work files. Open the target's unread Thread to inspect its response and History. Replies use a separate `send_bot_message` call addressed to the original source Bot ID.

## Local data

| Data | Default location or ownership |
| :--- | :--- |
| Product data, managed attachments, avatar uploads | `~/.local/share/omarchy-bot/` |
| Persistent runtime state and launch logs | `~/.local/state/omarchy-bot/` |
| Transient sockets | `$XDG_RUNTIME_DIR`; `serve` uses private `/tmp/ob-<uid>` when absent |
| Shared Workspace | User work files, separate from plugin source and conversation data |
| Native Sessions | Owned by the selected Agent, not erased by Bot deletion |

“Local” describes the application and its storage, not a promise of offline inference. Model connectivity depends on the configured Agent and provider.

> [!WARNING]
> **Every control request needs a Paired Device.** Every `/api/` control route and every WebSocket upgrade — projection, RFB, and the Sidecar device channel — requires a device token, including on loopback. The unauthenticated exceptions are `GET /api/health`, `POST /api/pairing/exchange` (a one-time code), and the provider `GET /api/plugins/oauth/callback` (guarded by single-use OAuth state). Pairing-code issue and Paired Device listing/revocation need either an authenticated Paired Device token or, from the Service Host's loopback peer, the Service Host secret from `<state>/pairing-host-secret`. Binding a non-loopback address requires your TLS certificate or a declared TLS-terminating proxy; otherwise startup fails. Private Wayland sockets are neither remote authentication nor an adversarial security sandbox. See [ADR 0015](docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

## Remote access

Three supported paths reach a Service from another machine. All three require a Paired Device.

- **SSH tunnel.** Keep the default loopback bind and forward the port: `ssh -L 7321:127.0.0.1:7321 user@host`. Enter `http://127.0.0.1:7321` and a one-time code in Omarchy Bot's Add Service screen; the Service sees a loopback peer.
- **Private network.** Reach the Service Host over your VPN or overlay. Keep the loopback bind and forward the port there, or bind the private interface with TLS as below.
- **TLS binding.** Set `OMARCHY_BOT_HOST` to the interface address and provide `OMARCHY_BOT_TLS_CERT` and `OMARCHY_BOT_TLS_KEY`, or declare `OMARCHY_BOT_TRUSTED_PROXY=<proxy-IP>` for a TLS-terminating proxy you control. On a systemd host, give the flags to `install`, `update`, or `reconfigure` so the unit carries them:

  ```bash
  OMARCHY_BOT_HOST=192.0.2.10 omarchy-bot reconfigure \
    --tls-cert /home/me/tls/cert.pem --tls-key /home/me/tls/key.pem
  ```

  `OMARCHY_BOT_HOST` and `OMARCHY_BOT_PORT` are read from the environment, so prefixing the command (or exporting them first) sets the recorded listener; `install`, `update`, and `reconfigure` take `OMARCHY_BOT_TLS_CERT`, `OMARCHY_BOT_TLS_KEY`, and `OMARCHY_BOT_TRUSTED_PROXY` as fallbacks for the flags, and omitted settings keep the saved configuration. Reconfigure rewrites the unit, reloads the manager, restarts the Service, and waits for health without replacing the runtime. The same three variables still work for a Launcher that inherits your shell environment: the container entrypoint, `scripts/serve.sh`, or a checkout `bun run dev`. Because the wait then connects to the new non-loopback address, use a certificate the host trusts; a self-signed one is accepted only while the address is loopback.

  Disable TLS again with explicit empty values, which also clears any saved certificate paths:

  ```bash
  omarchy-bot reconfigure --tls-cert "" --tls-key ""
  ```

  Because the installed setting persists in `<dataDir>/service.json`, `pair`, `devices`, `revoke`, the `install`/`update`/`reconfigure` health wait, and `doctor` then call the `https://` origin, and `status` prints it. A self-signed certificate is accepted only when the connection targets a loopback address; connecting to a remote host address requires a certificate that verifies normally. Redirects are refused. Manage the Service from the Service Host, or reach it over the SSH tunnel or VPN path above.

Pairing is required in every case. [ADR 0014](docs/adr/0014-require-paired-device-tokens.md) supersedes the [earlier transport decision](docs/adr/0004-defer-web-control-transport-security.md); [ADR 0013](docs/adr/0013-run-a-standalone-linux-service.md) records the standalone Service these paths reach.

Projection protocol v3 uses one WebSocket for PNG preview and Broker-authorized control/input, plus a separate bidirectional RFB WebSocket consumed by bundled noVNC 1.7 in view-only mode. WayVNC remote input and clipboard are disabled. `/api/computer/snapshot` remains a read-only fallback. There is no separate WebRTC/UDP listener. Every one of these connections requires the device token.

<details>
<summary><strong>Screen capacity and resolution</strong></summary>

The conservative admission policy defaults to at most **four 1080p Screens** and permits up to **eight with the 720p profile**:

```bash
OMARCHY_BOT_SCREEN_PROFILE=720p OMARCHY_BOT_SCREEN_CAPACITY=8 bun run dev
```

Eight Screens at 1080p are rejected before any excess Screen is provisioned. These are configuration limits, not a measured Sway performance approval. Historical Cage measurements do not authorize current production performance or Host Session safety claims.

</details>

## Repository

```text
apps/
  web/                     React conversation workspace
  daemon/                  Service API, persistence, orchestration
  cli/                     Install, unit, pairing, device, status, doctor, update, uninstall commands
workers/
  pi/                      Pi SDK adapter
packages/
  domain/                  Domain types and state transitions
  protocol/                REST and WebSocket schemas
  agent-contract/          Daemon / Agent worker protocol
  api-client/              Typed client
  omarchy-plugin/          Install-only Omarchy plugin package
scripts/                   Plugin runtime packaging
tests/                     Unit, integration, E2E, and conformance checks
docs/                      Product design, ADRs, research, inventories
```

The daemon is the only SQLite writer. Agent SDKs and native protocols run behind isolated workers. The browser talks only to the daemon.

## Design sources

| Start here | What it defines |
| :--- | :--- |
| [Product and interaction specification](docs/workspace-redesign.md) | Accepted product behavior and ownership boundaries |
| [Agent integration](docs/agents-integration.md) | Adapter contracts and capability inventories |
| [Technology selection](docs/technology-selection.md) | Runtime and frontend choices |
| [Context map](CONTEXT-MAP.md) | Domain vocabulary and documentation routing |
| [Architecture decisions](docs/adr/) · [Domain contexts](docs/contexts/) | System-wide and context-specific decisions |
| [Service ADR 0013](docs/adr/0013-run-a-standalone-linux-service.md) · [Pairing ADR 0014](docs/adr/0014-require-paired-device-tokens.md) · [Bot Computer ADR 0011](docs/contexts/computer-control/adr/0011-bundle-one-sway-bot-computer.md) | Standalone Service and install-only plugin, paired device tokens and the remote-access contract, one bundled Sway Bot Computer |
| [Research](docs/research/) | Focused primary-source investigations |

## License

[MIT](LICENSE) · Copyright © 2026 ColinShen

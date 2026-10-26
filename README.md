<div align="center">

# Omarchy Bot

**Your AI teammates. Your work files. Built for Omarchy.**

Create named Bots, work together in Threads, and see their desktop work in Bot Screens.

[![Platform: Omarchy x86_64](https://img.shields.io/badge/Omarchy-x86__64-183D32?style=flat-square)](#installation)
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
> **Current support:** the Service entry supports **x86_64 Linux**. The current installer is Omarchy's plugin manager; portable Bot Computer bundles and distribution conformance are tracked by the [standalone Linux Service specification](.scratch/standalone-linux-service/spec.md). **Pi** is the current Agent backend. Other Agents require an adapter and a passing versioned conformance inventory before becoming selectable. Omarchy Bot (Tauri) is planned, not shipped.

## Installation

Install and enable through Omarchy's official plugin manager:

```bash
omarchy plugin add https://github.com/XMethues/omarchy-bot.git --enable
```

Published runtimes include the built web client, native helpers, application source, and production dependencies. First enable uses a SHA-256-verified release artifact instead of running an install or compiler.

The plugin package only installs the Service. Enable runs the shared installer from the published runtime archive, reuses an already-installed Service, then starts the `omarchy-bot.service` user unit; disable stops that unit and leaves an installed helper watching until re-enable or checkout removal; removing the checkout uninstalls the Service and keeps user data. A graceful Shell teardown leaves the Service and its active Turns running: the teardown helper waits for the Shell to persist the plugin as disabled, which stops the Service, or for the plugin source directory to disappear, which uninstalls the Service and keeps user data. A re-enable ends that wait without touching the running Service, and a teardown with no Shell coming back keeps waiting. Shell hot reload keeps the plugin loaded. The package refuses hosts that are not Omarchy on x86_64; the generic `serve` entry checks no distribution.

<details>
<summary><strong>Runtime delivery and startup diagnostics</strong></summary>

The repository root manifest points Omarchy's plugin manager at `packages/omarchy-plugin`, and Omarchy Shell loads its `Service.qml`.

- **Bun resolution:** PATH, then mise, then a checksum-verified official Bun 1.4.2 download under `OMARCHY_BOT_HOME`.
- **Release artifacts:** `omarchy-bot-runtime-<sha>-x86_64.tar.zst` and its SHA-256 sidecar, published under `https://github.com/XMethues/omarchy-bot/releases/download/runtime-<sha>/`.
- **Runtime location:** `$XDG_DATA_HOME/omarchy-bot/runtime/current/`, or `$OMARCHY_BOT_HOME/runtime/current/` when overridden. Extraction is atomic and keeps the checkout clean and fast-forwardable.
- **No source fallback:** a network, server, or integrity failure stops startup rather than silently compiling.
- **Failure handling:** there is no supervisor lifeline and no `notify-send`; Quickshell does not parent the daemon. Install, startup, and unit failures go to the Service log and to `omarchy-bot status`.

Service log:

```text
~/.local/state/omarchy-bot/service.log
```

Set `OMARCHY_BOT_STATE` to relocate the log and other state. No host packages or Omarchy files are changed. The installed runtime also supports direct Service startup without Omarchy Shell; see below.

</details>

### Start an installed runtime

From an unpacked runtime, start the Service in the foreground:

```bash
bash /path/to/runtime/scripts/serve.sh
```

In a checkout, `bun run serve` calls the same entry. It requires Linux x86_64, Bash, Bun 1.4+, and `flock`; it performs no installation or downloads. Set `OMARCHY_BOT_BUN` to select a Bun executable. The Service logs to stdout/stderr and listens on `127.0.0.1:7321` by default. Existing `OMARCHY_BOT_HOME`, `OMARCHY_BOT_STATE`, `OMARCHY_BOT_HOST`, and `OMARCHY_BOT_PORT` settings apply.

Without `XDG_RUNTIME_DIR`, the entry creates `/tmp/ob-<uid>` with mode 0700 and exports it for transient sockets and the Bot Computer runtime. The short path leaves room for Linux's Unix-socket pathname limit. A per-user Service lock lives under `/tmp/omarchy-bot-<uid>/`, independent of login sessions and launcher settings. A second launch fails promptly and reports the running Service's PID. The Omarchy plugin starts and stops the Service through its systemd user unit. Shell hot reload keeps the plugin loaded, and a crash or SIGKILL leaves the Service running. A graceful Quickshell teardown also leaves the Service and its active Turns running: the teardown helper waits instead of stopping, and only a persisted disable stops the Service while removal of the plugin source directory uninstalls it and keeps user data.

`GET /api/health` accepts no token and returns only liveness and the Service version, for example `{"ok":true,"version":"0.1.0"}`. Control requests require a Paired Device token, including on loopback. Non-loopback listeners require TLS or a declared TLS-terminating proxy.

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

Open the pairing URL on the Service Host, or forward `7321` with `ssh -L 7321:127.0.0.1:7321 user@host` and open the URL locally. The default listener is loopback; host networking makes it reachable through that tunnel on Linux. No public registry image is published by this build command. Docker and Bun 1.4+, `curl`, and `unzip` are build prerequisites. The optional third build argument selects the asset cache (default `.lane/container-assets`); cache misses fetch checksum-pinned Bun and Chrome for Testing inputs. Docker build itself runs without network access, using the pinned Ubuntu 22.04 base; pull that base once if absent.

The Service runs as UID/GID 1000. The single named volume contains its database, pairing identity, Threads, artifacts, Shared Workspace, Agent credentials, and Bot Computer application/browser profile. Back up the volume while the container is stopped; recreate containers with the same volume to retain state. A bind mount must already be writable by UID 1000. Keep `HOME`, `OMARCHY_BOT_HOME`, and `OMARCHY_BOT_STATE` at their image defaults so state stays on that volume. Runtime locks and sockets are temporary. The image's browser binaries and fonts are installed at build time, so opening a local page in a Bot Screen needs no downloads. Docker stops use SIGINT so the Service closes the Bot Computer and flushes its application profile before exiting.

Use one running container per state volume. On startup the entrypoint clears Chromium's three transient singleton links, whose hostname and temporary socket refer to the previous container; browser profile data remains on the volume.

Before creating a Bot with the real Pi Agent, configure Pi's provider credentials in the persisted home and provision an authentic passing Pi conformance record for the image's exact Agent version. Credentials alone leave a fresh Agent `unconfigured`. A paired `GET /api/agents` reports the Pi entry's `version` field; use the record produced by a successful `bun test tests/conformance/pi.test.ts` against the matching runtime revision and Pi version (the suite prints its output path). Never create a success record manually or reuse the scripted worker's test record. Copy that record into the state volume, then restart the container to recheck readiness:

```bash
docker exec omarchy-bot mkdir -p /var/lib/omarchy-bot/data/conformance
docker cp /path/to/passing/pi-<version>.json omarchy-bot:/var/lib/omarchy-bot/data/conformance/
docker restart omarchy-bot
```

For an existing Service, a paired `POST /api/agents/pi/recheck` also reruns the probe; confirm `GET /api/agents` reports Pi `ready`. The image includes the production worker only. Its offline acceptance test mounts a separate scripted worker and proves container wiring rather than real provider authentication or model conformance.

`--shm-size=512m` gives Chromium sufficient shared memory. Chromium's namespace sandbox needs a host that permits unprivileged user namespaces and Docker's `--security-opt seccomp=unconfined`; this relaxes Docker's syscall filtering, so run the Service only with trusted Agent workloads. The browser's own sandbox remains enabled. The image never uses `--privileged`, mounts a desktop socket, or requires a host graphical session.

For remote HTTPS, set `OMARCHY_BOT_HOST=0.0.0.0` and mount a readable certificate/key with `OMARCHY_BOT_TLS_CERT` and `OMARCHY_BOT_TLS_KEY`. Alternatively, use `OMARCHY_BOT_TRUSTED_PROXY=<proxy-IP>` behind your TLS-terminating proxy and restrict network access to that proxy. Pairing remains required in both cases. `OMARCHY_BOT_PORT` changes the listener and health probe port. Docker's health check calls `/api/health`; `docker logs` receives Service stdout/stderr.

The local health probe sends no credentials and checks liveness only. With HTTPS it skips certificate identity validation so operator-managed self-signed certificates and certificates for the external DNS name still work; validate public TLS separately from container health.

Maintainers can run the real, offline acceptance test with `OMARCHY_BOT_CONTAINER_IMAGE=omarchy-bot:local bun test tests/integration/container-image.test.ts`. It mounts the scripted worker as a test fixture, pairs a client, creates a Bot and Thread, opens a real Bot Screen/browser, then recreates and restarts the container with the same volume and checks browser localStorage, conversations, and the paired token. It removes its private containers and volume on completion.


## Product model

**A Bot is a teammate. An Agent is its execution backend.** Each Bot references one immutable Agent; several Bots may use the same Agent. Adapters preserve native capabilities and approval behavior, rather than adding a separate permission policy or capability allowlist.

```text
                         Bot Client · Web
                                |
                       Localhost Bun daemon
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
- **Viewing is not execution.** Closing a viewer does not stop the Screen's applications. WayVNC supplies on-demand, view-only RFB projection; Computer Broker remains the input authority.
- **Work files outlive a Bot.** Deleting a Bot removes its Service-owned data and targeted Screen runtime/workspace, not Shared Workspace files, Agent-owned Native Sessions, or the shared Bot Computer profile.

The accepted [product specification](docs/workspace-redesign.md), [shared Bot Computer decision](docs/adr/0009-share-work-files-isolate-bot-screens.md), and [domain context map](CONTEXT-MAP.md) define the boundaries.

## Status

The current implementation includes a Bun daemon, React web client, SQLite persistence, isolated Agent workers, and the computer worker. Shared Sway runtime, routed Screens, shared application state, and selected-view projection are implemented.

**Host Session acceptance remains open.** Automated real-Sway conformance covers two routed Screens, shared profile/runtime markers, Agent control, projection, URL reuse, deletion/reprovision, and host environment isolation. It does not prove the user's top bar, shortcuts, or ordinary physical-input experience. See the [runtime decision and evidence](docs/contexts/computer-control/adr/0009-adopt-sway-bot-desktops.md).

Omarchy Bot (Tauri) will reuse the Web frontend while execution stays in the Service. [ADR 0010](docs/adr/0010-reuse-web-client-in-tauri.md) and [ADR 0011](docs/adr/0011-local-sidecar-only-off-host.md) define that contract; Tauri packaging and WebView compatibility are not implemented or verified by the current client. The application is Omarchy Bot, not a Desktop SKU.

A Local Sidecar host is external to this repository. The client shell that starts one must set the Sidecar's `OMARCHY_BOT_DEVICE_ID` to a `dev_<32hex>` identity and install the same value as `globalThis.__OMARCHY_BOT_DEVICE_ID__` before the Web bundle loads; the Web client then tags each send with it so the daemon can resolve that Sidecar as **This Device**. A browser tab, a mobile-class client, and Omarchy Bot on the Service Host install nothing and send no tag, so their Turns have no This Device. See [ADR 0011](docs/adr/0011-local-sidecar-only-off-host.md#client-side-device-identity) for the full shell contract.

## Development

From a local checkout:

```bash
bun install
bun run dev
```

Open **<http://127.0.0.1:7322>**. The daemon listens on `127.0.0.1:7321`; Vite proxies `/api` and WebSockets to it.

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
| **Bun 1.4+** | Workspace dependencies, daemon, and development commands |
| **Configured Pi installation** | Real Agent execution and Pi conformance |
| **`tar` with gzip support** | Extracting the checksum-verified Bot Computer bundle |
| **Docker** | Building the portable Bot Computer runtime and running its container conformance |
| **`computer-use-linux`** | Real desktop control |
| **Voxtype** | Composer dictation |
| **Network on first graphical use** | Checksum-verified portable browser download into the Bot Computer profile; the font supply ships inside the runtime archive |

On first graphical use, the Service uses the SHA-256-pinned Bot Computer bundle shipped inside its runtime archive under `<dataDir>/runtime/current/sway`. It contains Sway, wlroots, WayVNC, wlr-randr, Xwayland, grim, a private D-Bus daemon, and prebuilt capture/input/desktop helpers with their loader, libraries, and runtime data. The same archive runs on glibc and musl x86_64 Linux hosts; host grim, D-Bus, and a C toolchain are unnecessary. Point `OMARCHY_BOT_SWAY_BUNDLE_DIR` at the checksum-prepared `.lane/dist/sway` directory output by `bash scripts/build-sway-runtime.sh .lane/dist` to develop against a local bundle, and explicit binary overrides remain available.

The bundled `dbus-daemon` launcher defaults to its private `share/dbus-1/session.conf`; a caller-supplied `--config-file` takes precedence so the Bot Computer can use its own session configuration.

When runtime fonts are configured, the Service verifies them before starting Sway and passes their private fontconfig file to the compositor as well as applications, so tab titles render on hosts with no fonts installed.

Maintainers build the pinned sources and verify the resulting library closure with `bash scripts/build-sway-runtime.sh .lane/dist`. Run `sh scripts/sway-runtime/conformance/run.sh <archive.tar.gz>` for bundle-only Ubuntu 22.04 Bot Screen conformance and an Alpine loader smoke check. CI requires the built archive to match the checksum in `swayRuntimeSupply.ts`, and `bash scripts/package-plugin-runtime.sh . dist-runtime <archive.tar.gz>` embeds that verified bundle in the runtime archive; no separate Sway release is published.

The `distro-conformance` pull-request/manual workflow builds the same runtime archive without publishing it, then runs named jobs for Ubuntu 22.04/24.04, Debian 12, Fedora, Arch, openSUSE, and Alpine. Each installs the checksum-verified archive with the shared CLI extraction code and starts `scripts/serve.sh` under a container entrypoint (including Alpine's non-systemd path). A paired scripted Agent opens a real Screen, captures PNGs, opens a local page in the portable browser, and types text that the page reports back. Seam 3 runs the bundle/Xwayland/isolation suite, the tabbed-layout/dialog suite, and the portable-browser/CJK/shared-profile/snap-avoidance suite against that installed archive. Sway always uses headless pixman; no host compositor, display socket, GPU, systemd manager, or host configuration is mounted.

To repeat one job locally, prepare its image explicitly and supply a runtime archive plus its `.sha256` sidecar:

```bash
# Docker, Bun 1.4+, a cached base image, and network for image prerequisites are required.
# Replace the id with any entry in scripts/distro-conformance/matrix.json.
OMARCHY_BOT_DISTRO_BUILD=1 bun scripts/distro-conformance/run.ts ubuntu-22.04 /path/to/runtime.tar.zst
# Reuse the prepared image without pulling or rebuilding:
bun scripts/distro-conformance/run.ts ubuntu-22.04 /path/to/runtime.tar.zst
```

The image provides Bash, Bun (the native musl build on Alpine), `flock`, and development files only for the X11/Wayland test clients. The application and production dependencies come from the archive; tests never reinstall them. First browser use still needs the pinned Chrome and library download URLs. `OMARCHY_BOT_DISTRO_NETWORK=none` disables container networking to diagnose offline prerequisites; an uncached browser then fails explicitly. Runs use read-only inputs, a private temporary home/runtime/profile, no host ports or Docker volumes, and `--rm --init` for targeted process cleanup. The production CLI's systemd lifecycle is covered separately by installer fixtures; this matrix exercises the documented unpacked-runtime/container Launcher path.

The test container relaxes Docker's seccomp profile so Chromium can create its own user-namespace sandbox; it still runs as uid 1000 without privileged mode or host devices. Hosts that disable unprivileged user namespaces must enable them in their container/CI environment before browser conformance can pass; the runner does not change host sysctls or disable Chromium's sandbox.

The Bot Computer also supplies its own browser and fonts, so `open_url` works on a Service Host with no browser and pages render Latin and CJK text without host fonts. A natively installed browser is still preferred; snap-confined browsers are never launched, because a snap cannot see the Bot Computer's private home. The portable browser is a checksum-verified download prepared inside the Bot Computer profile, never installed on the host, and every Screen shares the one browser profile so sign-ins and session state carry over. The fonts are not downloaded: they ship inside the runtime archive at `<dataDir>/runtime/current/fonts`, and `OMARCHY_BOT_FONT_DIR` points at a locally prepared font directory for development. Each `open_url` opens a new window routed to the requesting Screen.

### Useful checks

```bash
bun run typecheck
bun test
bun run build
```

Real Pi conformance makes model calls and requires a configured Agent:

```bash
bun test tests/conformance/pi.test.ts
```

Real portable-browser conformance runs one private Sway Bot Computer on a fixture host with no browser on `PATH` and no visible host desktop entries, captures a Latin/Chinese/Japanese/Korean page from two Screens, and asserts real glyphs rather than empty boxes, one shared browser profile, and no snap launch. It needs a Sway runtime, `grim`, and `dbus-daemon`, downloads the pinned browser on first use, and skips without the flag:

```bash
OMARCHY_BOT_REAL_PORTABLE_BROWSER=1 \
OMARCHY_BOT_SWAY_BIN=$PWD/.lane/sway-cached/bin/sway \
OMARCHY_BOT_SWAYMSG_BIN=$PWD/.lane/sway-cached/bin/swaymsg \
OMARCHY_BOT_WLR_RANDR_BIN=$PWD/.lane/sway-cached/bin/wlr-randr \
OMARCHY_BOT_WAYVNC_BIN=$PWD/.lane/sway-cached/bin/wayvnc \
bun test tests/integration/bot-screen-portable-browser-conformance.test.ts
```

`OMARCHY_BOT_GRIM_BIN` and `OMARCHY_BOT_DBUS_DAEMON_BIN` override `grim` and `dbus-daemon` when they are not on `PATH`.

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
| Transient sockets and Voxtype transcript handoff | `$XDG_RUNTIME_DIR`; `serve` uses private `/tmp/ob-<uid>` when absent |
| Shared Workspace | User work files, separate from plugin source and conversation data |
| Native Sessions | Owned by the selected Agent, not erased by Bot deletion |

“Local” describes the application and its storage, not a promise of offline inference. Model connectivity depends on the configured Agent and provider.

> [!WARNING]
> **The control API has no application authentication.** Keep the default loopback binding unless you deliberately need trusted-LAN access. Anyone who can reach a non-loopback listener can access the control API, observe Screens, and send desktop input. Private Wayland sockets are neither remote authentication nor an adversarial security sandbox.

<details>
<summary><strong>Trusted-LAN access</strong></summary>

Opt both the daemon and Vite into non-loopback listeners:

```bash
OMARCHY_BOT_HOST=0.0.0.0 bun run dev
```

Open `http://<host-lan-ip>:7322` for development, or the configured production daemon address. Do not expose this listener to an untrusted network. HTTPS/WSS encrypts transport but does not establish application peer identity.

Projection protocol v3 uses one WebSocket for PNG preview and Broker-authorized control/input, plus a separate bidirectional RFB WebSocket consumed by bundled noVNC 1.7 in view-only mode. WayVNC remote input and clipboard are disabled. `/api/computer/snapshot` remains a read-only fallback. There is no separate WebRTC/UDP listener.

See the [transport security decision](docs/adr/0004-defer-web-control-transport-security.md).

</details>

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
  daemon/                  Local API, persistence, orchestration
  cli/                     Install, unit, and status commands
workers/
  pi/                      Pi SDK adapter
  computer/                Bot Screen computer backend
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
| [Research](docs/research/) | Focused primary-source investigations |

## License

[MIT](LICENSE) · Copyright © 2026 ColinShen

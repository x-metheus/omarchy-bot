<div align="center">

# Omarchy Bot

**AI teammates for Linux, macOS, and Windows.**

Create named Bots and work with each one in a continuous Conversation.

[![License: MIT](https://img.shields.io/badge/License-MIT-183D32?style=flat-square)](LICENSE)

[Install](#installation) · [Develop](#development) · [How it works](#product-model) · [Development workflow](#development-sources)

</div>

---

Omarchy Bot is a Tauri desktop app. It pairs with a standalone Rust Agent Daemon that runs Bots through Rig. The daemon can run on your computer or on another machine.

## Installation

Choose the desktop package for your platform from the [releases](https://github.com/x-metheus/omarchy-bot/releases). The desktop can start its local daemon or attach to an existing instance. Use the [Agent Daemon guide](apps/agent-daemon/README.md#headless-startup) to run the daemon on its own.

On first launch, connect to an Agent Daemon with its address and one-time pairing code. The desktop stores its credential in the OS keychain. Provision a model in desktop Settings after pairing. For a remote connection, use a private HTTPS endpoint such as [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

## Product model

Each Bot has one Conversation, a stable identity, and ongoing duties you can set in chat. The Agent can delegate work, accept corrections while it runs, and return results to the same Conversation. The daemon retains Message History and can use shared UserMemory, Observational Memory, and local Recall.

Add files to a Conversation or explicitly select a desktop file or working directory for a tool operation. Tools run on the daemon host by default. Desktop tool requests require native consent on the paired desktop. The [Agent Daemon guide](apps/agent-daemon/README.md) documents supported providers, pairing, attachments, tools, and Recall.

## Development

Install the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) and run these commands from the repository root.

```sh
bun install --frozen-lockfile
bun run tauri dev
```

Use the Tauri window for daily UI checks. The command starts Vite and compiles the Rust debug target as needed. Connect to a running Agent Daemon, or set `OMARCHY_BOT_AGENT_DAEMON_BIN` to an executable to check desktop-managed startup. See the [development guide](docs/development.md#desktop-project-layout) and [code map](docs/README.md#code-map).

Use `bun run typecheck` and `bun test` for the TypeScript checks. Run the native Rust checks from `apps/omarchy-bot/src-tauri` and the daemon's [controlled protocol tests](apps/agent-daemon/README.md#checks) from `apps/agent-daemon`.

Native lifecycle logs are stored in `~/.local/share/com.omarchy.bot/logs/omarchy-bot.log` on Linux (or under `XDG_DATA_HOME`), `~/Library/Logs/com.omarchy.bot/omarchy-bot.log` on macOS, and `%LOCALAPPDATA%\com.omarchy.bot\logs\omarchy-bot.log` on Windows.

### Legacy public site

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

## Releases

The tag-triggered [release workflow](.github/workflows/app-release.yml) builds desktop installers, signed updater artifacts, and standalone daemon archives. See the [Linux](scripts/linux-app/README.md), [macOS](scripts/macos-app/README.md), and [Windows](scripts/windows-app/README.md) guides for manual workflows and native packaging and verification commands.

## Development sources

| Start here | What it defines |
| :--- | :--- |
| [Project documentation](docs/README.md) | Documentation entry point and code and test routing |
| [Development workflow](docs/development.md) | Skill selection, project records, and verification commands |
| [Agent instructions](AGENTS.md) | Starting instructions for coding agents |
| [Issue tracker](docs/agents/issue-tracker.md) | Publishing specifications and tickets in GitHub Issues |
| [Domain documentation](docs/agents/domain.md) | Project terminology and architecture decisions |

## License

[MIT](LICENSE) · Copyright © 2026 ColinShen

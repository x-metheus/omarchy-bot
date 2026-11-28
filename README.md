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

Use the development setup below to run the app from source. The desktop can start its local daemon or attach to an existing instance. For standalone setup, see the [Agent Daemon guide](apps/agent-daemon/README.md#headless-startup). Desktop installers and standalone archives are tracked in the [first release checklist](https://github.com/x-metheus/omarchy-bot/issues/31).

On first launch, connect to an Agent Daemon with its address and one-time pairing code. The desktop stores its credential in the OS keychain. Provision a model in desktop Settings after pairing. For a remote connection, use a private HTTPS endpoint such as [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

## Product model

Each Bot has one Conversation, a stable identity, and ongoing duties you can set in chat. The Agent can delegate work, accept corrections while it runs, and return results to the same Conversation. The daemon retains Message History and can use shared UserMemory, Observational Memory, and local Recall.

Add files to a Conversation or explicitly select a desktop file or working directory for a tool operation. Tools run on the daemon host by default. Desktop tool requests require native consent on the paired desktop. The [Agent Daemon guide](apps/agent-daemon/README.md) documents supported providers, pairing, attachments, tools, and Recall.

## Development

Install [mise](https://mise.jdx.dev/getting-started.html) and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/). Run these commands from the repository root.

```sh
mise install
mise exec -- bun --cwd=apps/omarchy-bot install --frozen-lockfile
mise run dev
```

`mise run dev` runs `bun run tauri dev` in the desktop project. Tauri starts Vite and compiles the Rust debug target as needed. Connect to a running Agent Daemon, or set `OMARCHY_BOT_AGENT_DAEMON_BIN` to an executable to check desktop-managed startup. See the [development guide](docs/development.md#desktop-project-layout) and [code map](docs/README.md#code-map).

Run `cargo test --workspace --locked` from the repository root for the native workspace. Run frontend type checks and tests inside `apps/omarchy-bot`.

The App writes `omarchy-bot.log` and its managed Agent Daemon writes `agent-daemon.log` in the same directory.

| Platform | Log directory |
| --- | --- |
| Linux | `~/.local/share/com.omarchy.bot/logs` or `$XDG_DATA_HOME/com.omarchy.bot/logs` |
| macOS | `~/Library/Logs/com.omarchy.bot` |
| Windows | `%LOCALAPPDATA%\com.omarchy.bot\logs` |

Each log rotates at 5 MiB and keeps three numbered archives. The App also logs to stderr. A standalone Agent Daemon sends diagnostics to stderr and prints its `LISTENING` readiness line on stdout. A managed daemon uses the stderr stream inherited from the App when its log file is unavailable. The default level is `INFO`. Set `RUST_LOG=debug` or `RUST_LOG=omarchy_agent_daemon=trace` to increase first-party verbosity.

### Public site

The public site lives in `apps/site`. It uses Vite, TypeScript, and CSS. The pixel artwork, themes, and fonts carry their upstream attribution and licenses. [Website credits](apps/site/public/UPSTREAM-NOTICE.txt)

```bash
cd apps/site
bun install --frozen-lockfile
bun run dev   # http://127.0.0.1:7330
bun run build # dist
```

For Vercel, import the repository and set **Root Directory** to `apps/site`.
The site has its own Bun lockfile and publisher contract. `apps/site/vercel.json`
sets the pinned Bun install and build commands, static output directory, and
response headers. Deployment requires a signed-in Vercel account.
For a custom domain, set `SITE_URL` to its HTTPS origin for canonical URLs.
Vite previews the public pages. The publisher endpoints run on Vercel.

## Releases

The tag-triggered [release workflow](.github/workflows/app-release.yml) builds desktop installers, signed updater artifacts, and standalone daemon archives. See the [Linux](tools/release/linux-app/README.md), [macOS](tools/release/macos-app/README.md), and [Windows](tools/release/windows-app/README.md) guides for manual workflows and native packaging commands.

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

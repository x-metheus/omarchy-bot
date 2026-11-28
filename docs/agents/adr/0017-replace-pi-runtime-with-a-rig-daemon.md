# Replace the Pi runtime with a standalone Rust Agent Daemon

## Status

Accepted. This decision supersedes [ADR 0016](0016-build-bots-on-pi-durable.md).

## Decision

Run Bots through Rig in a standalone Rust Agent Daemon. Rig's headless harness, Inbox, and Subagents handle concurrent work and targeted corrections within one continuous Conversation per Bot. The daemon owns durable messages, events, work state, Bot profiles, and memory. This lets the daemon continue running independently of the Tauri desktop and lets a reconnecting client resume events against the same Conversation.

Paired desktop clients connect to a local daemon or a remote daemon over HTTPS. Provider credentials belong to the daemon that makes model requests. Tools run on the daemon host by default. An explicitly requested desktop operation runs in the paired Tauri app with local approval.

The Agent Daemon starts with a fresh database. Unstarted work can resume after a restart. Started work is marked interrupted and requires an explicit retry so a restart cannot repeat an unfinished tool operation. Original messages remain available alongside background Observational Memory and on-demand Recall. Verified UserMemory is shared by Bots on the same daemon and survives deletion of its source Bot.

[Approved specification](https://github.com/x-metheus/omarchy-bot/issues/13) · [Agent Daemon guide](../../../apps/agent-daemon/README.md)

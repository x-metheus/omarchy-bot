# The Bot Computer runtime owns input mechanics; retire the computer worker

Status: accepted on 2026-10-22. Supersedes the backend decision of [ADR 0001](./0001-computer-broker-backend.md). Implementation pending.

ADR 0001 made `workers/computer`, an MCP client of `@agent-sh/computer-use-linux`, the only process that touches desktop input. The Sway Bot Computer ([ADR 0009](./0009-adopt-sway-bot-desktops.md)) already replaced that in practice: input, capture, window observation and routing, and app/URL launch run in the daemon's Sway runtime through its private virtual-input helper, `grim`, and Sway IPC, and only `notify` still reaches the per-Screen worker. We record the runtime as the owner of input mechanics and remove the per-Screen computer worker, because the worker now costs a process, a readiness state, and a Screen failure mode for one action. `notify` is removed from the `computer` tool rather than moved: it targeted the Bot Computer's private D-Bus, and the runtime starts no notification server there, and the Host Session bus is off limits. A Bot reaches the user through its Thread.

Unchanged from ADR 0001: input coordination (who may act on a Screen) stays separate from input mechanics and adds no Agent permission layer; every Agent adapter sees one consistent `computer` tool surface.

## Considered Options

- **Route all actions back through the worker and `computer-use-linux`**: rejected; the runtime already targets each Bot Screen's output and workspace and holds the shared seat lease, so the worker would add a hop without owning any of that.
- **Keep the worker for `notify` only**: rejected; a supervised process per Screen for one action fails the deletion test.
- **Fold `notify` into the runtime**: rejected; the notification would still land on a bus nobody watches.

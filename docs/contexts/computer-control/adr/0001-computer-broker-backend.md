# ComputerBroker executes desktop actions through the computer-use-linux MCP server, not bespoke input code

_Single-Shared-Screen and Web Control backend portions were replaced by per-Bot Screens in [ADR 0007](./0007-provision-nested-hyprland-per-bot.md) (historical nested-Hyprland mechanism). Current compositor and lifetime: [ADR 0009](./0009-adopt-sway-bot-desktops.md) and [system ADR 0009](../../../adr/0009-share-work-files-isolate-bot-screens.md). [ADR 0008](./0008-run-cage-bot-desktops.md) is historical Cage evidence. Emergency Control portions are superseded by [ADR 0006](./0006-remove-emergency-control.md). The MCP computer-worker backend decision is superseded by [ADR 0010](./0010-daemon-owns-bot-computer-input.md)._

The Computer boundary requires that only `computer-worker` touches real desktop input, and that every Agent adapter sees one consistent tool surface (observe, screenshot, windows, click/type/key/scroll). We decided `workers/computer` is an MCP **client** that spawns the official `@agent-sh/computer-use-linux` stdio MCP server as its backend, adding only the small actions that server lacks (open app/URL, desktop notifications) natively.

Considered options:

- **Reimplement input/screenshot directly** on ydotool/wtype/grim/hyprctl — full control, but duplicates a maintained upstream tool bridge and risks drifting from the tool surface the docs mandate.
- **Reuse its pi extension** — couples the computer backend to one Agent's extension format.

The MCP server keeps input coordination in the daemon separate from input mechanics in the worker and gives a clean seam if the backend is ever swapped. Shared-screen arbitration and emergency control stay in the daemon/ComputerBroker regardless of backend; they prevent interleaved input and do not add an Agent permission layer. Emergency control is surfaced only while computer input is active or stopped, never as permanent idle Sidebar chrome.

Consequence: `computer-worker` availability depends on the upstream binary and is probed independently of the Agent registry; the Computer surface degrades to observation-only if input is unavailable.

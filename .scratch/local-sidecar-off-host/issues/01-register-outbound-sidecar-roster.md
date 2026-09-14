# 01: Register an outbound Local Sidecar on the device channel

**What to build:** Let a scripted outbound Local Sidecar connect to the plugin daemon, register as a distinct machine, and appear on a public device roster so a Bot Client can see which computers can run local work. This is the first demoable path: a laptop-shaped device is online on the plugin host without a Tauri window, a listener on the laptop, or a change to conversation or Bot Screen projection.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] A dedicated device WebSocket accepts outbound Sidecar connections and is not the event stream or a projection/RFB socket.
- [x] Registration records a stable device identity, hostname, online state, and capabilities limited to shell, search, files, and transfer (not screenshot or Takeover).
- [x] Public HTTP exposes enough roster for a client to know whether an online Sidecar exists, without reading Sidecar internals.
- [x] A live heartbeat keeps the device online; a disconnect removes it from the executable roster so Bots cannot target a closed laptop.
- [x] Reconnecting with the same device identity replaces the prior socket rather than leaving two executable copies of one machine.
- [x] Two registrations with different device identities remain distinct roster entries.
- [x] The Sidecar never listens; the daemon bind stays loopback under the current unauthenticated listener policy, and this ticket does not treat a non-loopback bind as pairing.
- [x] Protocol tests cover device-channel and roster DTOs the way existing protocol tests cover projection and Bot mail.
- [x] Harness coverage uses the public HTTP/WebSocket seam plus the scripted outbound fixture; it does not require Tauri, WebView, or a real Omarchy Bot window.
- [x] Product copy and identifiers use Omarchy Bot and Local Sidecar; they do not introduce Desktop, Desktop Client, Omarchy Bot Desktop, or Bot Desktop as the client name.

## Answer

Public `GET /api/devices` lists online Local Sidecars. A dedicated `/api/devices` WebSocket accepts outbound registration and heartbeat; the same device identity replaces the prior socket, distinct identities stay distinct, and disconnect removes the device from the executable roster. Screenshot and Takeover capabilities are rejected. `ApiClient.listDevices()` reads the roster and does not spawn a Sidecar.

Validation:

- `bun test packages/protocol/src/devices.test.ts tests/integration/local-sidecar.test.ts` — 10 passed
- `bun run typecheck` — passed

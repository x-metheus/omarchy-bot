# 08: Ship the plugin-runtime Bun Local Sidecar

**What to build:** Ship the real Local Sidecar as TypeScript run by Bun from the plugin runtime: an outbound-only process that registers, asks, and executes `run` / `search` / `read` / `write` / `transfer` the way the fixture already proved. It is not an Agent worker, daemon, Bot Screen, compiled binary, or Tauri app.

**Blocked by:** 05: Search, read, and write on the Sidecar; 06: Transfer files between Sidecar and Shared Workspace; 07: Remember Always/Never per Omarchy Bot install

**Status:** resolved

- [x] The production Sidecar is TypeScript executed by Bun from the plugin runtime layout; this ticket does not `bun --compile`, reimplement execution in Rust, or add a second Bun on the plugin host.
- [x] It speaks the same outbound device channel as the fixture: registration, heartbeat, approval, and `local` job frames; it never listens and is never an Agent worker, plugin daemon, or Bot Screen.
- [x] It implements `run`, `search`, `read`, `write`, and `transfer` with Sidecar-side Ask / Allow once / Always / Never in an isolated sandbox.
- [x] Closing the Sidecar process unregisters that device only; plugin-host Agents, Native Sessions, Shared Workspace, and Bot Computer keep running.
- [x] The scripted fixture remains the daemon contract seam; a focused test runs the production Sidecar against the public listener without Tauri, WebView, live Docker, or a physical Host Session.
- [x] This ticket does not add a Tauri crate, remote pairing/TLS, WebView RFB claims, or `0.0.0.0` as a substitute for pairing; the Web client stays the reusable non-Sidecar UI.

## Answer

The production Local Sidecar is TypeScript at `apps/sidecar/src/main.ts`, executed by the plugin-runtime Bun. It connects outbound to `ws://127.0.0.1:$OMARCHY_BOT_DAEMON_PORT/api/devices`, never listens, asks on stdout, and accepts Allow once / deny / Always / Never on stdin. `run` / `search` / `read` / `write` / `transfer` execute under `OMARCHY_BOT_SIDECAR_ROOT`. Closing the process unregisters that device; plugin-host native `bash` continues. No `bun --compile`, Tauri crate, or `0.0.0.0`.

Validation:

- `bun test tests/integration/local-sidecar-runtime.test.ts` — 1 passed

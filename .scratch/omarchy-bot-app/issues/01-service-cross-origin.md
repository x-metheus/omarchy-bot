# 01: Service accepts cross-origin requests from the app

**What to build:** The Service lets the embedded Omarchy Bot UI reach it from the app's own origin. HTTP requests from `tauri://localhost`, `http://tauri.localhost`, and `https://tauri.localhost` (and loopback development origins only when the Service runs in development mode) receive CORS responses; every other origin does not. Every WebSocket upgrade (events, projection, RFB, device channel) is refused before authentication when it carries an Origin outside the allowlist, and accepted when the Origin is absent (the Local Sidecar) or allowlisted. Pairing is not weakened: unauthenticated requests are still rejected.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] CORS preflight from each allowlisted origin succeeds without a token and returns the allowed methods and headers
- [x] Actual requests from an allowlisted origin still require a device token and return 401 without one
- [x] Requests from a non-allowlisted origin get no CORS allow headers
- [x] Credentials (cookies) are never allowed in CORS responses
- [x] Loopback development origins are allowed only in development mode
- [x] WebSocket upgrades with a foreign Origin are refused before token checks; absent or allowlisted Origins proceed to normal authentication
- [x] Covered by tests at the Service HTTP/WebSocket boundary using the in-process harness

## Comments

Implemented Tauri-origin CORS (`tauri://localhost`, `http[s]://tauri.localhost`) with unauthenticated preflight while token auth stays enforced on actual requests, no credentials, and loopback origins only under opt-in `OMARCHY_BOT_DEV=1`; all WS upgrades reject foreign Origins before authentication. Review clean. Final `bun test`: 790 pass, 17 skip, 0 fail; `bun run typecheck` passed.

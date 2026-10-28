# 01: Service accepts cross-origin requests from the app

**What to build:** The Service lets the embedded Omarchy Bot UI reach it from the app's own origin. HTTP requests from `tauri://localhost`, `http://tauri.localhost`, and `https://tauri.localhost` (and loopback development origins only when the Service runs in development mode) receive CORS responses; every other origin does not. Every WebSocket upgrade (events, projection, RFB, device channel) is refused before authentication when it carries an Origin outside the allowlist, and accepted when the Origin is absent (the Local Sidecar) or allowlisted. Pairing is not weakened: unauthenticated requests are still rejected.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] CORS preflight from each allowlisted origin succeeds without a token and returns the allowed methods and headers
- [ ] Actual requests from an allowlisted origin still require a device token and return 401 without one
- [ ] Requests from a non-allowlisted origin get no CORS allow headers
- [ ] Credentials (cookies) are never allowed in CORS responses
- [ ] Loopback development origins are allowed only in development mode
- [ ] WebSocket upgrades with a foreign Origin are refused before token checks; absent or allowlisted Origins proceed to normal authentication
- [ ] Covered by tests at the Service HTTP/WebSocket boundary using the in-process harness

# 06: Device pairing and tokens

**What to build:** Every Bot Client is a Paired Device. The Service Host issues short-lived one-time pairing codes and a one-time pairing URL; a client exchanges one for a revocable device token. Every HTTP route and WebSocket upgrade (conversation, projection, RFB, Local Sidecar device channel) requires a valid token, loopback included; only pairing exchange and health accept unpaired callers (ADR 0014). The Web client and API client carry the token, and the Local Sidecar presents its install's token while keeping its This Device claim.

**Blocked by:** 01

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] Unpaired requests to every route family and every socket receive 401 (Seam 1).
- [x] A valid pairing code yields a device token once; reuse and expiry are rejected.
- [x] Revoking a Paired Device makes its next request and its open sockets fail.
- [x] Tokens are stored hashed and never appear in logs or model-visible output.
- [x] A Local Sidecar registers and receives `local` jobs only with a valid token; This Device resolution is unchanged.
- [x] The Web client completes the one-time pairing URL flow and then works normally.
- [x] Existing integration suites pass through the harness with a paired token.

## Answer

Every `/api` route and WebSocket upgrade requires a Paired Device token. `GET /api/health`, `POST /api/pairing/exchange`, and `GET /api/plugins/oauth/callback` stay open (the provider redirect carries a single-use state and cannot present a token). The static UI stays open so `/pair?code=` can load. Codes are 8 characters, single-use, 10 minutes, and the name issued with the code is kept when the exchange omits one. Tokens are 32 random bytes, stored as SHA-256, compared with `timingSafeEqual`. Revoke closes open sockets with 1008 and the next request is 401. The Web client and API client send `Authorization: Bearer`; sockets, images, and the Local Sidecar send `access_token`. A `local.run` drops `OMARCHY_BOT_DEVICE_TOKEN` from the child environment. The `dev_<32hex>` This Device claim is unchanged.

Loopback is not a user boundary, so minting a code requires the mode-0600 `pairing-host-secret` in the state dir (or an already-paired token). Ticket 07's `pair` CLI can read that file. Ticket 08 still owns TLS and the projection `authentication: "none"` literal.

## Comments

`bunx tsc --noEmit` clean. Pairing, health, daemon, api-client, and the pairing page: 41 pass, 0 fail. Sidecar, projection, display settings, client tag, attachments: 39 pass, 0 fail. Transfer, files, policy, same-host, migrations, broker redaction: 42 pass, 0 fail. Mailbox, computer, permanent deletion: 39 pass, 0 fail. Pairing, sidecar, and plugin services after the OAuth exemption and env strip: 26 pass, 0 fail. After the review fixes, pairing plus the pairing page: 23 pass, 0 fail, and `tsc --noEmit` was clean again. Not run: `tests/integration/service-supervision.test.ts` (known Sway bundle pin), `tests/conformance/pi.test.ts` (real model; its harness now pairs), the real-Sway browser check, and Playwright. Commit `d778a56`, not pushed.

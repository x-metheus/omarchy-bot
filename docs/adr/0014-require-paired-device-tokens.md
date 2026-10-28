# Require paired device tokens for every Bot Client

Status: accepted on 2026-10-24. Supersedes [ADR 0004](0004-defer-web-control-transport-security.md). Implementation is tracked by [the standalone Linux Service specification](../../.scratch/standalone-linux-service/spec.md). Amended on 2026-10-28 by [ADR 0015](0015-omarchy-bot-app-is-the-only-bot-client.md): the Service serves no `/pair` page or static client, and installation ends by opening an `omarchy-bot://pair` deep link.

A standalone Service runs on shared workstations and cloud hosts ([ADR 0013](0013-run-a-standalone-linux-service.md)), where an unauthenticated listener hands any local user or network peer the Bots' shells, files, and Bot Screens. Every HTTP request and WebSocket upgrade, including the projection and RFB sockets and the Local Sidecar device channel, therefore presents a **device token** issued by pairing. Loopback is not exempt, because on a multi-user host every local account can reach `127.0.0.1`.

Pairing is explicit and local to the Service Host: the Service prints a short-lived one-time pairing code (or a one-time pairing URL the installer opens for the local user), and a Bot Client exchanges it for a device token bound to a named **Paired Device**. Tokens are stored only as hashes, are revocable individually from the Service Host, and never appear in model-visible output, logs, or the Shared Workspace. A Local Sidecar authenticates with the token of the Omarchy Bot install that started it; its `dev_<32hex>` identity remains the This Device claim of ADR 0011.

Binding to a non-loopback address requires TLS: either a certificate the operator supplies, or a declared trusted TLS-terminating proxy. Without one the Service refuses to start on that address rather than serving plaintext tokens.

## Considered Options

- **Keep ADR 0004 and rely on loopback**: rejected; loopback is not a user boundary on a shared host, and cloud use needs remote access.
- **Unix socket with 0700 permissions only**: rejected as the sole mechanism; browsers and remote clients cannot use it. It remains acceptable as an additional Launcher-local transport later.
- **Accounts with passwords**: rejected for v1; the Service has one owner, and per-device tokens give revocation without a password store.

## Consequences

- This is the breaking public-protocol cutover ADR 0004 anticipated. Unpaired clients receive 401 on every `/api/` control route and every WebSocket upgrade, except the pairing exchange, the provider's OAuth callback (guarded by single-use state), the static Bot Client files and `/pair` page, and the unauthenticated health probe, which reveal no Bot, Thread, or host data. Pairing-code issue and Paired Device management accept either an authenticated Paired Device token or, from the loopback Service Host peer, the mode-0600 host secret.
- Existing local use must pair once: installation, including through the Omarchy plugin, ends by opening the one-time pairing URL in the local browser, so ordinary local use stays one click.
- Multiple Paired Devices may be connected at once; Takeover and input leases already arbitrate Bot Screen control between them.

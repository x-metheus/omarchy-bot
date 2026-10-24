# 06: Device pairing and tokens

**What to build:** Every Bot Client is a Paired Device. The Service Host issues short-lived one-time pairing codes and a one-time pairing URL; a client exchanges one for a revocable device token. Every HTTP route and WebSocket upgrade (conversation, projection, RFB, Local Sidecar device channel) requires a valid token, loopback included; only pairing exchange and health accept unpaired callers (ADR 0014). The Web client and API client carry the token, and the Local Sidecar presents its install's token while keeping its This Device claim.

**Blocked by:** 01

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] Unpaired requests to every route family and every socket receive 401 (Seam 1).
- [ ] A valid pairing code yields a device token once; reuse and expiry are rejected.
- [ ] Revoking a Paired Device makes its next request and its open sockets fail.
- [ ] Tokens are stored hashed and never appear in logs or model-visible output.
- [ ] A Local Sidecar registers and receives `local` jobs only with a valid token; This Device resolution is unchanged.
- [ ] The Web client completes the one-time pairing URL flow and then works normally.
- [ ] Existing integration suites pass through the harness with a paired token.

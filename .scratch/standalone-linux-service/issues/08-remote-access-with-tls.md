# 08: Remote access with TLS

**What to build:** A Service can be reached from another machine: binding a non-loopback address requires an operator certificate or a declared trusted TLS-terminating proxy, and startup is refused otherwise. A remote Paired Device can use every feature, including plugin account OAuth.

**Blocked by:** 06

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] Non-loopback bind without certificate or declared proxy fails startup with a clear error (Seam 1).
- [ ] With a certificate, HTTPS and WSS serve all routes and sockets and still require tokens.
- [ ] Behind a declared proxy, the Service trusts forwarded scheme and host only from that proxy.
- [ ] Plugin OAuth started from a remote client origin completes and returns to that origin.
- [ ] Two Paired Devices on different origins arbitrate Web Control through Takeover and input leases.

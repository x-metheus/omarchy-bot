# 04: Protocol version check

**What to build:** The health probe reports a protocol version (an integer owned by the protocol package, starting at 1) alongside the Service version. On connect, the UI compares it with the versions the app supports; outside that range it shows a blocking screen that names whether the app or the Service must be updated, with the app's update action when the app is behind.

**Blocked by:** 02 (Web UI runs behind the `shell` seam)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] Health probe includes the protocol version, still without authentication and without Bot, Thread, or host data
- [ ] A supported version connects normally
- [ ] A Service ahead of the app shows "update Omarchy Bot"; a Service behind shows "update the Service"
- [ ] No other screen is reachable while the mismatch screen is shown
- [ ] Covered by a Service-boundary test and an e2e spec with a simulated mismatched Service

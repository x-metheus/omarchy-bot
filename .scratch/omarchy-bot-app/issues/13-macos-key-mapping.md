# 13: ⌘ key mapping during Takeover

**What to build:** When the shell reports macOS, Takeover sends ⌘ as Ctrl and ⌥ as Super to the Bot Screen by default, with a per-device override (stored by the shell) that sends ⌘ as Super. Other platforms and the paste path are unchanged.

**Blocked by:** 02 (Web UI runs behind the `shell` seam)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] On macOS, ⌘C/⌘V/⌘ shortcuts arrive in the Bot Screen as Ctrl shortcuts
- [ ] On macOS, ⌥ arrives as Super
- [ ] The override switches ⌘ to Super and persists for this device
- [ ] Linux and Windows key handling is unchanged
- [ ] Covered by an e2e spec with the in-memory shell reporting macOS

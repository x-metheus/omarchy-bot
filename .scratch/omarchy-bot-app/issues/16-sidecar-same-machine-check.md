# 16: Sidecar decides "same machine" by host identity, not by loopback address

**What to build:** The app decides whether to start the Local Sidecar by asking whether the paired Service runs on this machine, not by whether its address is loopback. A user who reaches a remote Service through an SSH tunnel to `localhost` gets the Sidecar and can approve `local.run`, file and search actions on their own computer (stories 21, 32–34). A user whose Service really is on the same machine gets no Sidecar, whether they connect through loopback or through a LAN/HTTPS address. This restores the spec line "the existing same-host check is unchanged" and ADRs 0011/0015 ("only when it is not connected to the plugin daemon on the same machine").

Recommended mechanism (the agent may choose another if it records why): the Service exposes a non-secret host identity to Paired Devices, for example a per-install random salt plus a digest of that salt and the host's machine ID. The app computes the same digest from its own machine ID and compares. A different machine cannot recover the machine ID from the digest. On macOS and Windows the comparison is always "different machine". If the check cannot be completed, the app starts no Sidecar and shows that local actions are unavailable and why. It never guesses "off-host".

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md), [ADR 0011](../../../docs/adr/0011-local-sidecar-only-off-host.md). Origin: PR #10 code review (Spec (a), Standards hard violation 2).

- [ ] A remote Service reached through a loopback SSH tunnel starts the Sidecar; an approved `local.run` runs on the client machine (integration test with two distinct host identities over loopback transport)
- [ ] A same-machine Service reached through loopback **or** a non-loopback address starts no Sidecar
- [ ] An unreachable or failing host-identity check starts no Sidecar and surfaces a recoverable "local actions unavailable" notice
- [ ] The host identity reveals no raw machine ID and requires a Paired Device token
- [ ] The "shortcut: loopback tunnels also suppress the Sidecar" comment, and the README and ticket text that describe the loopback-only detector, are replaced with the new rule. The macOS release checklist no longer says a tunnel cannot establish `local.run` acceptance
- [ ] Review cleanups in the same code: the https→wss Service URL rewrite exists once; the `tests/unit` device-id test name says "Web UI" instead of the Avoid-listed "Web client"

# 09: Compiled Sidecar inside the app

**What to build:** The Local Sidecar is compiled with `bun build --compile` for each target and bundled in the app. When the app connects to a Service that is not on the same machine, it starts the Sidecar as a child with the install's `dev_` identity, Service URL, and token, and stops it on quit or unpair. The Sidecar's approval requests appear in the UI through the shell with the exact command or path and Ask / Always / Never; Always and Never are remembered per install. Pending local jobs fail clearly when the app quits.

**Blocked by:** 07 (Omarchy Bot app on Linux), 08 (Sidecar connects by URL and reports its OS and shell)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] The compiled linux-x64 binary passes the Local Sidecar integration suite
- [ ] No Sidecar starts when the Service is on the same machine
- [ ] Quitting or unpairing terminates the Sidecar, and the Service reports pending local jobs as failed
- [ ] Approval prompts render with the exact command or path; Always/Never persist across restarts for this install
- [ ] Messages sent from this install carry its `dev_` tag; the identity matches the Sidecar's registration
- [ ] The Linux smoke suite runs one approved `local.run` end to end

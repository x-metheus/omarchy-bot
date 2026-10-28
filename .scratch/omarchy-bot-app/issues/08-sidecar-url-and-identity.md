# 08: Sidecar connects by URL and reports its OS and shell

**What to build:** The Local Sidecar connects to a Service URL (`ws`, or `wss` for TLS Services) instead of a loopback port. Its registration declares `os` (`linux`, `macos`, `windows`) and `shell` (`posix-sh`, `powershell-5.1`); the Service stores them on the roster and includes them in the `local` tool's description of This Device, so the Agent writes matching syntax. Command execution sits behind one executor interface with the current POSIX implementation; the secret-directory denylist is defined per operating system (Linux and macOS lists here). Screenshot, pointer, and compositor refusals apply everywhere.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] The Sidecar connects to `ws` and `wss` Service URLs and authenticates with `access_token`
- [ ] Registration without valid `os` and `shell` is rejected
- [ ] The `local` tool description for a Turn names This Device's OS and shell
- [ ] The POSIX executor keeps existing cancel/timeout process-group teardown behavior
- [ ] macOS credential locations are refused on macOS; existing Linux refusals unchanged
- [ ] Covered by the Local Sidecar integration suite, including a `wss` case against a TLS harness

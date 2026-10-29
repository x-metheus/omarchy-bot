# 08: Sidecar connects by URL and reports its OS and shell

**What to build:** The Local Sidecar connects to a Service URL (`ws`, or `wss` for TLS Services) instead of a loopback port. Its registration declares `os` (`linux`, `macos`, `windows`) and `shell` (`posix-sh`, `powershell-5.1`); the Service stores them on the roster and includes them in the `local` tool's description of This Device, so the Agent writes matching syntax. Command execution sits behind one executor interface with the current POSIX implementation; the secret-directory denylist is defined per operating system (Linux and macOS lists here). Screenshot, pointer, and compositor refusals apply everywhere.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] The Sidecar connects to `ws` and `wss` Service URLs and authenticates with `access_token`
- [x] Registration without valid `os` and `shell` is rejected
- [x] The `local` tool description for a Turn names This Device's OS and shell
- [x] The POSIX executor keeps existing cancel/timeout process-group teardown behavior
- [x] macOS credential locations are refused on macOS; existing Linux refusals unchanged
- [x] Covered by the Local Sidecar integration suite, including a `wss` case against a TLS harness

## Comments

Implemented the outbound URL-based Sidecar: `OMARCHY_BOT_SERVICE_URL` (`ws`/`wss`), device token auth, required `os`/`shell` registration carried through the roster into the `local` tool description, and a POSIX executor behind an executor interface that preserves process-group teardown on cancel, timeout, and shutdown. Secret-directory refusal is defined per OS (Linux unchanged; macOS lists refused on macOS), with screenshot, pointer, and compositor refusals everywhere. No native macOS execution; Linux integration tests exercise the OS policy cases.

Verification: full `bun test` 798 pass, 17 skip, 0 fail (4,792 assertions, 815 tests / 120 files, 527.33s); nested Pi conformance 11/11 steps pass; `bun run typecheck` (`tsc --noEmit`) success in 6.60s.

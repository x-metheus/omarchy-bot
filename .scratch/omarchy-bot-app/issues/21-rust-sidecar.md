# 21: Rust Local Sidecar passes the existing Sidecar suites on every OS

**What to build:** A Rust Local Sidecar, built as its own small executable, that behaves exactly like the current TypeScript one:
- the same environment variables;
- the same outbound WebSocket connection and registration with OS and shell;
- `local.run` with POSIX `sh` process groups on Linux and macOS, and Windows PowerShell 5.1 under a Job Object on Windows;
- cancel and timeout killing the whole command tree;
- file operations, transfer and search with the same refused paths, including the macOS Keychain/TCC paths and the Windows credential paths, case-insensitive with NTFS short-name expansion;
- the same stdin/stdout JSON approval contract.

The existing black-box Sidecar integration and compiled-binary suites run against it unchanged, apart from pointing them at the new binary. It is built in the repository's container on Linux (CARGO_HOME under `.lane`, never the host's `~/.cargo`) and on the macOS and Windows CI runners. The TypeScript Sidecar stays in place until ticket 22.

**Blocked by:** 20 (Record the decision to build the Local Sidecar in Rust)

**Status:** ready-for-agent

Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] The Local Sidecar integration suites pass against the Rust binary on Linux x64 (locally, in the container)
- [ ] The same suites pass on the macOS (arm64, x64) and Windows x64 CI runners
- [ ] The protocol message types are checked against the TypeScript protocol package by the mechanism ADR 0015 names
- [ ] The release binary is reported in the ticket Comments, with a size comparison to the Bun build per target

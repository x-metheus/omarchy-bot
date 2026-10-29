# 20: Record the decision to build the Local Sidecar in Rust

**What to build:** The architecture records that the Local Sidecar becomes a small standalone Rust program, still bundled with Omarchy Bot and still launched as a separate child process, replacing the `bun build --compile` TypeScript Sidecar. The reason is size: the Bun runtime makes the Sidecar about 110 MB of the 150 MB AppImage. Direct OS process control (POSIX process groups, Windows Job Objects) is a further reason. The behaviour contract does not change: environment variables, the WebSocket protocol, registration with OS and shell, the stdin/stdout JSON approval contract, refused paths, and teardown on quit or unpair. The message types shared with the TypeScript protocol package must have one source of truth, a schema or a cross-language contract test, so that the two sides cannot drift.

**Blocked by:** None (can start immediately)

**Status:** resolved

Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md), [ADR 0011](../../../docs/adr/0011-local-sidecar-only-off-host.md). Decided with the user in conversation on 2026-10-29.

- [x] ADR 0015 (and ADR 0011 wherever it describes the Sidecar's implementation language or packaging) records the Rust Sidecar, the unchanged contract, the separate-process choice, and why it is not in-process
- [x] The ADR names how the protocol types stay in sync across TypeScript and Rust
- [x] The spec's Sidecar implementation and testing lines are updated to match; no code changes in this ticket

## Comments

Rust Sidecar decision recorded. ADR 0015 names the standalone Rust program, built per target and bundled as a Tauri external binary, still launched as a separate child process replacing the `bun build --compile` TypeScript Sidecar: the bundled Bun runtime was about 110 MB of the 150 MB AppImage, and direct POSIX process-group and Windows Job Object control belongs in the executor. It also records why the Sidecar stays out of process (panic and runaway isolation, independent teardown on quit or unpair, shipped-binary test boundary). The behaviour contract is unchanged: environment variables, WebSocket protocol, OS/shell registration, stdin/stdout JSON approval contract, refused paths, and quit/unpair teardown. ADR 0011 carries the matching amendment.

Protocol types keep one source of truth: the TypeScript schemas (`packages/protocol/src/devices.ts`, `packages/agent-contract/src/local-protocol.ts` `LOCAL_SCHEMA`), with one language-neutral JSON fixture corpus under `packages/protocol/fixtures/sidecar/`; the TypeScript suite derives coverage requirements from those schemas and the Rust consumer deserializes the same fixtures. Fixture and consumer work is owned by tickets 21 and 22; this ticket changes documentation only.

Verification: `bun test` 847 passed, 31 skipped, 0 failed; `bun run typecheck` passed; real Pi conformance passed with a private supplied DeepSeek recipe, cleaned up afterwards.

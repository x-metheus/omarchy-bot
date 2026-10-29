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

**Status:** needs-info

Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] The Local Sidecar integration suites pass against the Rust binary on Linux x64 (locally, in the container)
- [ ] The same suites pass on the macOS (arm64, x64) and Windows x64 CI runners
- [x] The protocol message types are checked against the TypeScript protocol package by the mechanism ADR 0015 names
- [ ] The release binary is reported in the ticket Comments, with a size comparison to the Bun build per target

## Comments

2026-10-29 Rust sidecar implementation and Linux verification (final review clean; macOS/Windows runners unavailable):

`apps/sidecar-rust/` is a standalone Rust executable behaving like the TypeScript Sidecar: the same environment variables, the same WebSocket registration carrying `os`/`shell`, POSIX `sh` process groups on Linux and macOS, Windows PowerShell 5.1 under a kill-on-close Job Object, cancel and timeout tearing down the whole tree, the per-OS credential denylists (including macOS Keychain/TCC and Windows Credentials/Protect/Vault/Crypto) with NTFS short-name expansion, file operations, transfer and search with the same refused paths, and the same stdin/stdout JSON approval contract. TLS is self-contained (vendored OpenSSL; `ldd` reports only libc/libm/libgcc). The TypeScript Sidecar and its executor/policy suite remain in place until ticket 22. The existing integration suites select the Rust executable through `OMARCHY_BOT_TEST_SIDECAR_BINARY`; no test behavior changed beyond that helper.

Protocol contract: ADR 0015's mechanism is implemented as one language-neutral corpus in `packages/protocol/fixtures/sidecar/`, covering both frame directions, every `LOCAL_SCHEMA` action and both presence and absence for every optional property. `packages/protocol/src/sidecar-fixtures.test.ts` derives those requirements from the authoritative devices-frame schemas and `LOCAL_SCHEMA`, and rejects any fixture whose schema parse changes its JSON. The Rust fixture test consumes the identical corpus with unknown fields rejected and equal re-serialized JSON. Adding a variant, action, or optional property fails coverage until the corpus and both consumers change.

CI: `.github/workflows/sidecar-conformance.yml` now builds with Rust 1.93.1 on Linux x64 in the repository image (`CARGO_HOME`/`CARGO_TARGET_DIR` under `.lane`) and on hosted macOS arm64 (`macos-15`), macOS x64 (`macos-15-intel`), and Windows x64 (`windows-latest`). Each target runs both fixture consumers, the Rust process suite via `OMARCHY_BOT_TEST_SIDECAR_BINARY`, retains the TypeScript executor/policy and compiled-Bun process coverage, and records measured Rust/Bun release sizes in the job summary plus a `sidecar-sizes-<target>` JSON artifact. Linux additionally runs the daemon lifecycle and transfer suites in the image. This workflow has not executed on macOS or Windows.

Review: two P2 findings were fixed with regressions that failed before and pass after — canonicalization of root paths, and normalization ordering. Independent whole-diff review was otherwise clean; the final root review was clean.

Verification chronology: the complete `PI_CODING_AGENT_DIR=<worktree>/.lane/ticket21-agent bun test` with the Rust binary selector and the default `.lane` assets produced **850 pass, 31 skip, 0 fail**, 5,503 assertions, 881 tests in 128 files (511.20 s), with real Pi conformance passing. That run used the release built before the final root-path fixes; an earlier attempt with a global asset-dir override was contaminated (2 failures), was rerun with the clean environment where the affected 49 tests passed, and then completed fully green. After the fixes, a rebuilt container release passed `cargo test --locked --manifest-path apps/sidecar-rust/Cargo.toml` (**10 pass**), and the selected Rust-binary process/runtime/transfer suites plus the TypeScript fixture suite passed: **21 pass, 2 Windows skips, 0 fail**, 168 assertions (55.82 s). `bun run typecheck`, `lint:boundaries`, and actionlint passed. A Windows GNU `cargo check --tests` passed compile-only; no Windows runtime is claimed. The private Pi auth/model/settings directory was removed and host settings were untouched.

Measured final Linux x64 release and Bun 1.4.4 comparison:

| Target | Rust release | Bun 1.4.4 release |
| --- | ---: | ---: |
| linux-x64 | 7,827,896 B | 109,594,800 B |
| darwin-arm64 | pending | 89,622,242 B |
| darwin-x64 | pending | 98,627,040 B |
| windows-x64 | pending | 115,744,256 B |

The Bun figures are local cross-builds. Rust sizes for the three non-Linux targets do not exist because those builds have not run; they are reported as pending rather than estimated, so the per-target comparison checkbox stays open.

Needs-info blocker: the branch is unpublished — the remote `app/21-rust-sidecar` ref returns 404 and GitHub shows 0 self-hosted runners, while this work must not push or dispatch. The existing hosted macOS arm64/x64 and Windows x64 run (https://github.com/x-metheus/omarchy-bot/actions/runs/40867789160) exercised only the prior TypeScript implementation at `208a9db`, so it is not evidence for the Rust binary. Consequently the macOS/Windows acceptance cannot be observed and the non-Linux Rust sizes cannot be measured. Next prerequisite: authorized publication of the current branch (or runners that build it), after which the already-configured `sidecar-conformance` matrix produces the macOS/Windows results and the remaining Rust sizes. The stale code is not pushed or dispatched, and the two OS CI checkboxes and the per-target size comparison remain unchecked.

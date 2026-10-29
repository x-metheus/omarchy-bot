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

Needs-info blocker as first recorded on 2026-10-29 (superseded by the CI follow-up comment below; kept as history): the branch was then unpublished — the remote `app/21-rust-sidecar` ref returned 404 and GitHub showed 0 self-hosted runners, while this work must not push or dispatch. The existing hosted macOS arm64/x64 and Windows x64 run (https://github.com/x-metheus/omarchy-bot/actions/runs/40867789160) exercised only the prior TypeScript implementation at `208a9db`, so it is not evidence for the Rust binary. Consequently the macOS/Windows acceptance could not then be observed and the non-Linux Rust sizes could not be measured, and the stale code was not pushed or dispatched. The prerequisite named at that point was authorized publication of the current branch; it has since been met by the user, as the follow-up below records. The two OS CI checkboxes and the per-target size comparison still remain unchecked.

2026-10-29 CI follow-up on the published branch: first macOS/Windows results, their two defects, and the repairs (unverified on Apple/Windows):

The branch is now at `30e8019` (merge of `app/18-native-paths-behind-shell`, carrying tickets 18 and 19, into `linux-service`), and `bun install` with Bun 1.4.4 completed there without changing `bun.lock`. The first `sidecar-conformance` run on the published branch (PR 10, run 40873704759) gave the first native Apple/Windows evidence: the Linux x64 job passed, and the two macOS jobs and the Windows job each failed for a different reason.

macOS arm64 (job 123447016219) and macOS x64 (job 123447016417) failed only in the trusted, paired TLS step: the child exited 1 before emitting `ask`. The test then discarded the child's stderr, so the exact native backend error is not available and no backend message is asserted here. The likely cause is the fixture itself, not the Sidecar's TLS trust: it served one self-signed certificate carrying `basicConstraints CA:TRUE` and no `serverAuth` extended key usage or subject alternative names beyond an IP, which Apple's TLS server policy can reject even when `NODE_EXTRA_CA_CERTS` trusts it. That remains a high-confidence diagnosis, not a confirmed native cause.

Windows x64 (job 123447016358) failed the search step with the exact observed mismatch `nested\file.txt: needle` expected, `C:\Users\runneradmin\AppData\Local\Temp\.tmpy9buiE\nested\file.txt: needle` received. The cause is confirmed: only the search start path was expanded to its NTFS short name, not the root, so stripping the root prefix off hits did not match and hits came back absolute. Every hit the job reported was still confined to the requested root; only their spelling was wrong.

Repairs:

- The TLS fixture now has OpenSSL generate a temporary CA and a separate server leaf issued by it. The CA has `basicConstraints CA:TRUE` and key-cert-sign/cRL-sign usage; the leaf has `CA:FALSE`, digital-signature/key-encipherment usage, the `serverAuth` extended key usage, and `IP:127.0.0.1` plus `DNS:localhost` subject alternative names. The successful connection trusts that CA through `NODE_EXTRA_CA_CERTS`; the untrusted and unpaired cases still run with no trusted CA and with an unpaired token. Certificate validation and hostname verification are unchanged, and no product TLS code or validation bypass was added.
- An unexpected exit of the trusted child now reports the child's stderr with the device token and its URI-encoded form redacted, instead of failing on a bare exit-code assertion, so a future native failure names its own cause.
- On Windows the search root is now long-path spelled the same way as the confined start path in `apps/sidecar-rust/src/execute.rs`, restoring relative hits under a short-name root. The new `search_under_short_root_returns_relative_hits_and_refuses_secrets` test requires a witnessed short alias before it runs, asserts the relative hit text, and asserts that a search aimed at the Credentials directory is refused; no assertion was weakened.

Verification on the merged tree at `30e8019` with those repairs, after `bun install`: `cargo test --locked` on `apps/sidecar-rust` passed 10, 0 failed; the release build passed; the selected Rust release process/runtime/transfer suites plus the TypeScript fixture suite passed 21, with the 2 Windows-only tests skipped, 0 failed; the shared process suite with the Rust binary selector unset passed 5 with 2 skipped, 0 failed; `bun run typecheck` passed; and a private Rust 1.93.1 `cargo check --locked --tests --target x86_64-pc-windows-gnu` compiled the Windows test target, compile-only, since no Windows runtime is available here. The Linux x64 release is 7,827,896 B, unchanged, against 109,594,800 B for Bun 1.4.4. Independent review of the final diff against `30e8019` was clean. Nothing here is native macOS or Windows execution, so neither repaired path is claimed to pass there; the full unrelated Bun/Pi suite was not rerun for this repair, and the earlier 850-pass run remains historical evidence. The repaired matrix run is pending, the user publishes and reports it, this work pushed and dispatched nothing, the Status stays needs-info, and both the macOS/Windows checkbox and the per-target size comparison stay open.

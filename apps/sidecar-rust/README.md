# Rust Local Sidecar

`omarchy-bot-sidecar` is the standalone outbound Local Sidecar. The TypeScript Sidecar and application packaging stay in place until ticket 22. This crate has its own lockfile and is not part of the Tauri Cargo workspace.

The runtime accepts `OMARCHY_BOT_SERVICE_URL` (`ws` or `wss`, without URL credentials), `OMARCHY_BOT_DEVICE_ID`, `OMARCHY_BOT_DEVICE_TOKEN`, `OMARCHY_BOT_SIDECAR_ROOT`, and optional `OMARCHY_BOT_HOSTNAME`. It connects to `/api/devices`, registers OS/shell capabilities, and sends a heartbeat every ten seconds. Approval requests and dismissals are JSON stdout lines; stdin accepts `allow-once`, `deny`, `always`, and `never` decisions, optionally naming a `jobId`. Closing stdin, receiving SIGINT/SIGTERM, or losing the Service cancels running work before exit. Remembered rules live in `.omarchy-bot-local-policy.json` under the root.

Linux/macOS execute `/bin/sh` in a private process group with an stdin anchor, TERM grace, and KILL escalation. Windows executes Windows PowerShell 5.1 inside a kill-on-close Job Object; user code is gated until assignment. Normal PowerShell completion releases successfully launched applications, while explicit exit keeps descendants cancellable. File actions retain the TypeScript lexical confinement, per-OS credential denylists (including expanded Windows short paths), compositor refusals, and UTF-16 character result limits. This is the same approval boundary as the TypeScript runtime; the shell command itself is not an OS sandbox.

TLS uses native platform trust on Windows/macOS and statically linked vendored OpenSSL on Linux. `NODE_EXTRA_CA_CERTS` adds PEM roots for the existing private-CA contract. Server certificates must satisfy the platform's TLS policy; Apple's policy requires subject alternative names and the `serverAuth` extended key usage. The process fixture serves a CA-issued leaf with both extensions and trusts its temporary CA. No dynamic OpenSSL library is required on Linux. Certificate validation and hostname verification remain enabled.

Build Linux in the repository image with private caches:

```sh
mkdir -p .lane/sidecar-rust/{home,cargo,target}
docker build -t omarchy-bot-linux-app -f scripts/linux-app/Dockerfile scripts/linux-app
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/src" -w /src \
  -e HOME=/src/.lane/sidecar-rust/home \
  -e CARGO_HOME=/src/.lane/sidecar-rust/cargo \
  -e CARGO_TARGET_DIR=/src/.lane/sidecar-rust/target \
  omarchy-bot-linux-app bash -c 'cargo test --locked --manifest-path apps/sidecar-rust/Cargo.toml && cargo build --release --locked --manifest-path apps/sidecar-rust/Cargo.toml'
```

Point process tests at `.lane/sidecar-rust/target/release/omarchy-bot-sidecar` using `OMARCHY_BOT_TEST_SIDECAR_BINARY`. The `sidecar-conformance` workflow runs the canonical TypeScript and Rust fixture consumers, builds native releases, exercises process tests on Linux x64/macOS arm64/macOS x64/Windows x64, and records Rust/Bun sizes. Linux also runs daemon lifecycle and transfer tests in the image.

Local evidence on 2026-10-29: Rust 1.93.1 Linux container release built successfully; process/runtime/transfer and TypeScript fixture suites passed (21 passed, two Windows-only skips). Windows GNU `cargo check --tests` passed; this is compilation evidence only. The Linux release was 7,827,896 bytes versus 109,594,800 bytes for `bun build --compile --target=bun-linux-x64` (92.9% smaller). `ldd` showed libc, libm, and libgcc only. macOS/Windows execution and Rust release sizes remain unverified until this branch is available to the hosted CI runners; configured CI is not execution evidence.

The complete native Bun suite passed with the Rust binary selected: 850 passed, 31 skipped, zero failed, including all eleven real Pi conformance steps. That run began before the final root-normalization correction; the final source was subsequently rebuilt and verified with all ten Linux Rust tests and the complete selected process/runtime/transfer suites above. Both root regressions were observed failing before their fixes. `bun run typecheck`, `bun run lint:boundaries`, and workflow `actionlint` passed. Private Pi configuration copies were removed after verification.

| Target | Rust release bytes | Bun 1.4.4 compiled bytes |
| --- | ---: | ---: |
| Linux x64 | 7,827,896 | 109,594,800 |
| macOS arm64 | Awaiting native runner | 89,622,242 |
| macOS x64 | Awaiting native runner | 98,627,040 |
| Windows x64 | Awaiting native runner | 115,744,256 |

The three non-Linux Bun baselines were cross-compiled locally and were not executed here.

# Rust Local Sidecar

`omarchy-bot-sidecar` is the standalone outbound Rust Local Sidecar bundled in Omarchy Bot on Linux x64, macOS arm64/x64, and Windows x64. This crate has its own lockfile and is not part of the Tauri Cargo workspace.

The runtime accepts `OMARCHY_BOT_SERVICE_URL` (`ws` or `wss`, without URL credentials), `OMARCHY_BOT_DEVICE_ID`, `OMARCHY_BOT_DEVICE_TOKEN`, `OMARCHY_BOT_SIDECAR_ROOT`, and optional `OMARCHY_BOT_HOSTNAME`. It connects to `/api/devices`, registers OS/shell capabilities, and sends a heartbeat every ten seconds. Approval requests and dismissals are JSON stdout lines; stdin accepts `allow-once`, `deny`, `always`, and `never` decisions, optionally naming a `jobId`. Closing stdin, receiving SIGINT/SIGTERM, or losing the Service cancels running work before exit. Remembered rules live in `.omarchy-bot-local-policy.json` under the root.

Linux/macOS execute `/bin/sh` in a private process group with an stdin anchor, TERM grace, and KILL escalation. Windows executes Windows PowerShell 5.1 inside a kill-on-close Job Object; user code is gated until assignment. Normal PowerShell completion releases successfully launched applications, while explicit exit keeps descendants cancellable. File actions use lexical confinement, per-OS credential denylists (including expanded Windows short paths), compositor refusals, and UTF-16 character result limits. The shell command itself is not an OS sandbox.

TLS uses native platform trust on Windows/macOS and statically linked vendored OpenSSL on Linux. `NODE_EXTRA_CA_CERTS` adds PEM roots for the existing private-CA contract. Server certificates must satisfy the platform's TLS policy; Apple's policy requires subject alternative names and the `serverAuth` extended key usage. The process fixture serves a CA-issued leaf with both extensions and trusts its temporary CA. No dynamic OpenSSL library is required on Linux. Certificate validation and hostname verification remain enabled.

Build Linux in the repository image with private caches:

```sh
mkdir -p .lane/sidecar-rust/{home,cargo,target}
docker build -t omarchy-bot-linux-app -f scripts/linux-app/Dockerfile scripts/linux-app
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/src" -w /src \
  -e HOME=/src/.lane/sidecar-rust/home \
  -e CARGO_HOME=/src/.lane/sidecar-rust/cargo \
  -e CARGO_TARGET_DIR=/src/.lane/sidecar-rust/target \
  omarchy-bot-linux-app bun scripts/build-sidecar.ts
```

The build script runs `cargo build --release --locked --manifest-path apps/sidecar-rust/Cargo.toml`, then copies the native release executable to `apps/omarchy-bot/src-tauri/binaries/omarchy-bot-sidecar-<triple>[.exe]`, the Tauri external-binary path. It honors `CARGO_HOME` and `CARGO_TARGET_DIR`, defaulting both to private directories under `.lane/sidecar-rust` when unset. The Linux, macOS and Windows app builders invoke this same script with their platform build directories.

Build before running `bun test`. Sidecar integration tests resolve `OMARCHY_BOT_TEST_SIDECAR_BINARY` first, then the bundled host executable; a missing executable reports how to build it. To test the uncopied Cargo output, point the environment variable at `.lane/sidecar-rust/target/release/omarchy-bot-sidecar` (`.exe` on Windows).

Run the crate's protocol, policy and executor tests with `cargo test --locked --manifest-path apps/sidecar-rust/Cargo.toml` using the same private-cache container environment. The `sidecar-conformance` workflow runs the canonical TypeScript and Rust fixture consumers, builds native releases, exercises process tests on Linux x64/macOS arm64/macOS x64/Windows x64, and records Rust release sizes. Linux also runs daemon lifecycle and transfer tests in the image.

Historical ticket 21 Linux measurements on 2026-10-29 were 7,827,896 bytes for the Rust release and 109,594,800 bytes for the removed Bun-compiled Sidecar (92.9% smaller). Current per-target release measurements come from the workflow's `sidecar-sizes-<target>` artifacts. Native macOS/Windows builds and packaged WebView acceptance require their platform runners; Linux results do not establish that evidence.

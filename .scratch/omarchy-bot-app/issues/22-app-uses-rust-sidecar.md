# 22: Omarchy Bot ships the Rust Sidecar and the TypeScript Sidecar is removed

**What to build:** The app bundles and launches the Rust Local Sidecar on Linux, macOS and Windows. The TypeScript Sidecar, its `bun build --compile` step and its per-target Bun binaries are deleted. Users see no behaviour change, and the installers shrink. Approval prompts, Always/Never persistence, the `dev_` identity, quit/unpair teardown and failed pending jobs all behave as before.

**Blocked by:** 21 (Rust Local Sidecar passes the existing Sidecar suites on every OS), 16 (Sidecar decides "same machine" by host identity)

**Status:** ready-for-agent

Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] Linux AppImage smoke runs one approved `local.run` end to end with the Rust Sidecar
- [ ] macOS dmg and Windows NSIS CI jobs build and bundle the Rust Sidecar; the Windows install check passes
- [ ] No TypeScript Sidecar source, build script or bundled Bun Sidecar binary remains; the package-boundary tests are updated
- [ ] Installer sizes before and after are recorded per platform in Comments
- [ ] Review cleanups in the same code: the Sidecar decision is a typed value, not a string; approvals are typed, not `serde_json::Value`; the restart exit code has a descriptive name; `approvalId` and `jobId` naming is consistent

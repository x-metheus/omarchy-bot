# 07: Installer, systemd user unit, and CLI

**What to build:** One installer sets up the Service on any systemd distribution without root: it unpacks the checksum-verified runtime archive, installs a user unit, and ends by opening the one-time pairing URL. A CLI provides install, start, stop, status, pair, devices, revoke, update, uninstall, and doctor. It replaces the stale repository-root user unit.

**Blocked by:** 01, 06

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] Install on a non-Omarchy fixture home starts the Service under a user unit and opens a pairing URL (Seam 2).
- [x] A checksum mismatch aborts install or update without extracting.
- [x] Extraction works without host `zstd`.
- [x] Installing when a Service already exists reuses it rather than creating a second.
- [x] `status` reports state, address, and the last startup failure from the Service log.
- [x] `doctor` lists each missing prerequisite and suggests lingering when no persistent login exists.
- [x] `uninstall` removes the runtime and unit and keeps Bots, Threads, Shared Workspace, and Bot Computer profile.
- [x] The stale repository-root unit is removed.

## Answer

The `omarchy-bot` CLI in `apps/cli` installs a checksum-verified `.tar.zst` runtime without host zstd or root, writes a systemd user unit whose ExecStart is the installed `scripts/serve.sh`, waits for `/api/health`, and opens the pairing URL. Commands: install, start, stop, status, pair, devices, revoke, update, uninstall, doctor. Host-secret bearer auth on loopback can list and revoke devices (`apps/daemon/src/api/http.ts`) without a device token. The stale root unit is gone.

## Comments

- `bun run typecheck` (`tsc --noEmit`) exit 0.
- `bun test` of `tests/unit/runtime-archive.test.ts`, `tests/unit/cli-lifecycle.test.ts`, `tests/unit/cli-commands.test.ts`, `tests/integration/service-install.test.ts`, `tests/integration/service-host-devices.test.ts`, `tests/integration/device-pairing.test.ts`: `46 pass, 0 fail, 306 expect() calls, Ran 46 tests across 6 files.`
- Not run, pre-existing and out of scope: `tests/integration/service-supervision.test.ts` (pinned Sway bundle unpublished) and `tests/conformance/pi.test.ts` (real model).
- Security review: checksum before extract, path and symlink-chain confinement, modes, no root, `systemctl --user` only. A symlink-chain escape was found and fixed; the follow-up case is in `tests/unit/runtime-archive.test.ts`.

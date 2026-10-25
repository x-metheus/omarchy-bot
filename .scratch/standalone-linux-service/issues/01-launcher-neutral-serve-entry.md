# 01: Launcher-neutral `serve` entry

**What to build:** Any Launcher can start the Service on any x86_64 Linux host through one `serve` entry, not only Omarchy Shell. The generic path no longer rejects non-Omarchy distributions, creates a private 0700 runtime directory when the host provides none, holds one per-user Service lock, and exposes an unauthenticated health route that reports only liveness and version. The existing Omarchy plugin keeps working by calling the same entry until ticket 11 replaces it.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] `serve` starts the Service from an installed runtime on a non-Omarchy fixture host (Seam 2).
- [x] Omarchy plugin fixture suite stays green, now routed through `serve`.
- [x] With no host runtime directory, the Service uses a private 0700 directory for locks, sockets, and the Bot Computer runtime.
- [x] A second `serve` for the same user fails fast on the per-user lock and names the running Service.
- [x] The health route answers without a token and its body contains only liveness and version (Seam 1).
- [x] x86_64 remains enforced; non-x86_64 hosts are rejected with a clear message.

## Answer

Any x86_64 Linux launcher starts an installed runtime through `scripts/serve.sh`. The generic path does not read the distribution. With no `XDG_RUNTIME_DIR` it creates mode 0700 `/tmp/ob-<uid>` and exports it. One flock at `/tmp/omarchy-bot-<uid>/service.lock` is shared with the Omarchy plugin; a second `serve` exits 1 and names the running pid. `GET /api/health` needs no token and returns only `{ ok, version }` from the daemon manifest. The plugin stays Omarchy-only and execs that same entry.

## Comments

Private `/tmp` directories are claimed with one `O_NOFOLLOW` open, then `fchmod` on that fd, so a swapped path cannot redirect the chmod. A `service.lock` symlink left in the directory is refused.

Evidence: `bun test tests/integration/service-launcher.test.ts tests/integration/omarchy-plugin.test.ts tests/integration/service-health.test.ts tests/integration/plugin-runtime-package.test.ts` — 23 pass, 0 fail, 108 expect(), 7.86s. `bun run typecheck` (`tsc --noEmit`) exit 0. Full `bun test` was not re-run; an earlier lane run's extra failures (dictation, native MCP, shared-workspace cwd, Vite) do not call `serve`.

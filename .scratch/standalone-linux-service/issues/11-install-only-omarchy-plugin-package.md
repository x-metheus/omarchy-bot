# 11: Move the Omarchy plugin into an install-only package

**What to build:** The Omarchy plugin becomes its own workspace package that works only on Omarchy and only installs the Service: enabling it runs the shared installer (or reuses an installed Service) and starts the user unit, disabling stops it, removal uninstalls the Service and keeps user data. The root manifest only points Omarchy's plugin manager at the package. Quickshell no longer parents the daemon, so Shell reloads leave Bots running, and the supervisor lifeline leaves the Service.

**Blocked by:** 07

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [x] `omarchy plugin add` with the root manifest installs and starts the Service through the package (Seam 2).
- [x] Enabling on a host with a CLI-installed Service reuses it.
- [x] Simulated Quickshell termination of the plugin leaves the Service and an active Turn running.
- [x] Disable stops the Service; remove uninstalls it and keeps user data.
- [x] The package refuses to run on non-Omarchy hosts.
- [x] Dependency rules fail the build if any other package imports from the plugin package or the plugin imports Service source.
- [x] The old launcher, supervisor, and lifeline code is removed from the Service.

## Comments

### 2026-10-26

Evidence: after the final lifecycle lock, `bun test tests/integration/omarchy-plugin-package.test.ts tests/integration/omarchy-plugin-lifetime.test.ts tests/integration/service-launcher.test.ts` passed with 18 pass, 0 fail, and 154 assertions (LifecycleLock agent). `bun run typecheck` passed after that change. The earlier full suite, before the lifecycle/lock follow-ups, reported 665 pass, 13 skip, and 1 fail: the known baseline capability-key mismatch in `tests/conformance/pi.test.ts` using a real model. `bun run lint:boundaries` reported 2 pass. The full suite was not rerun after the lifecycle lock. The root build script and `plugin-runtime.yml` run `lint:boundaries`; its test fails on forbidden imports. `bun install` was required because this worktree had no `node_modules`; it updated `bun.lock` for the new workspace package.

Residuals: the graceful Quickshell teardown limitation recorded here is fixed by [ticket 15](15-shell-restart-keeps-service-running.md): settle now waits for the Shell to persist the plugin as disabled, for a re-enable, or for the plugin source directory to disappear, so a graceful teardown no longer stops the Service on its own. The scope of that fix is the `settle` script seam in `packages/omarchy-plugin/entry.sh` exercised by the integration fixtures, not live QML destruction on a real host. Hot reload (`manifest.keepLoaded`) and SIGKILL leave the Service and an active Turn running. The lifetime test uses the production daemon and a scripted Turn; systemd and the Screen adapter are faked.

A disabled plugin leaves an outside-checkout poller until re-enable or the checkout disappears. That poller uninstalls on remove because the host deletes the checkout only after disable. Removing an already-disabled plugin has no destroy hook; the earlier disable's poller covers removal only while that poller is alive. A graceful teardown or a session ending with no Shell coming back leaves a waiting watcher with no deadline: it waits for a persisted disable, a re-enable, or the removal of the plugin source directory, because the host writes neither a disable nor a removal deadline. The poller, and the graceful/session-ending watcher that waits, are exercised through the package fixtures with private HOME/XDG directories and a fake systemctl; live QML destruction, real host systemd, and actual Shell operations on the running graphical session were not exercised.

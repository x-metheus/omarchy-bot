# 15: Omarchy Shell restart keeps the Service running

**What to build:** A graceful Omarchy Shell teardown (`omarchy restart shell`, which uses `quickshell kill`) no longer stops the Service. Today `packages/omarchy-plugin/Service.qml` runs `entry.sh settle` on `Component.onDestruction`, and `settle` calls `stop` immediately because the Shell persists a disable to `shell.json` only after destroying the plugin. Instead, `settle` must decide from what happens next: the plugin is re-enabled (new generation) → it was a restart, leave the Service running; `shell.json` shows the plugin disabled → stop the Service; the plugin source directory disappears → uninstall, keeping user data.

**Blocked by:** 11 (resolved)

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] A graceful teardown of the plugin followed by a re-enable (simulated `omarchy restart shell`) leaves the Service and an active Turn running throughout.
- [x] A graceful teardown followed by the Shell persisting the plugin as disabled stops the Service.
- [x] A disable followed by removal of the plugin source directory uninstalls the Service and keeps user data.
- [x] A graceful teardown with no Shell coming back (session ending) does not stop the Service by itself.
- [x] `tests/integration/omarchy-plugin-lifetime.test.ts` covers graceful teardown, not only SIGKILL.
- [x] Ticket 11's residuals note is updated.

## Comments

### 2026-10-26

Implemented behavior: `packages/omarchy-plugin/entry.sh` `settle` no longer stops the Service on teardown. It polls and decides from what happens next: a re-enable advances the plugin generation and ends the wait, so the Service and any active Turn keep running across a Shell restart; a valid persisted disable in `shell.json` stops the Service once; the plugin source directory disappearing uninstalls the Service and keeps user data. A missing, malformed, unsupported, or still-enabled config leaves the Service running. The stop and uninstall paths recheck the generation, the config, and the installed CLI under the existing plugin lock; the polling sleeps hold no lock. No new state file, grace deadline, or snapshot was added and `Service.qml` was not changed.

Evidence (red before the production edits, then green, same command):

```
bun test tests/integration/omarchy-plugin-package.test.ts tests/integration/omarchy-plugin-lifetime.test.ts
```

- Red before production edits: 8 pass, 6 fail; 14 tests, 2 files, 16.20s. The real-daemon graceful restart and all three no-return config states observed the unwanted `--user stop omarchy-bot.service`.
- Final green: 16 pass, 0 fail, 177 assertions; 2 files, 31.59s.

Independent final validation:

```
bun test tests/integration/omarchy-plugin-package.test.ts tests/integration/omarchy-plugin-lifetime.test.ts tests/integration/service-launcher.test.ts
```

24 pass, 0 fail, 216 assertions, 31.88s.

```
bun test
```

681 pass, 13 skip, 1 fail; 695 tests across 107 files, 3,990 assertions, 1,248.91s. The suite is not green: the sole failure matches the known baseline in `tests/conformance/pi.test.ts:355`, which expects capability keys without `plugins` while the actual inventory includes it (the preceding assertion requires `plugins: true`). It is the same failure as the 676-pass/1-fail baseline and is unrelated to this change. `bun run typecheck` passed (exit 0, `tsc --noEmit`, 5.94s wall). The full suite includes the package-boundary checks. No other unexpected failures.

Review: an independent review of the actual diff found no evidence-backed patch-introduced defect. It checked the settle/enable race, lock inheritance and lifetime, poller cleanup, and the meaning of the tests and the preserved data. Two known residuals remain by design: duplicate settles can each stop the same disabled generation, and an older residual watcher is protected against a newer enable by the locked generation recheck.

Cleanup: settle and the simulated Shell processes run in private process groups that the fixtures kill and await; the real daemon shuts down gracefully with a targeted group-kill fallback and stops its scripted worker; the package fake Service is cleaned up by its recorded PID; sockets and fixture directories are removed. A post-run process inspection found no pollers, Services, or workers belonging to this worktree; leftovers from another worktree were left untouched. No containers or volumes were created and the host was not changed.

Not verified: live QML destruction, real `omarchy plugin` commands, `omarchy restart shell`, the running host Shell, real host systemd, and the actual Screen adapter were not exercised. The Shell/QML behavior is covered through the `settle` script seam with fixtures, a fake systemctl, and a fake Screen adapter; the lifetime test uses the production daemon and a scripted Turn. Builds, formatters, and a separate boundary lint run were not executed.

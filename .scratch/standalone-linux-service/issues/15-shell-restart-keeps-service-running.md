# 15: Omarchy Shell restart keeps the Service running

**What to build:** A graceful Omarchy Shell teardown (`omarchy restart shell`, which uses `quickshell kill`) no longer stops the Service. Today `packages/omarchy-plugin/Service.qml` runs `entry.sh settle` on `Component.onDestruction`, and `settle` calls `stop` immediately because the Shell persists a disable to `shell.json` only after destroying the plugin. Instead, `settle` must decide from what happens next: the plugin is re-enabled (new generation) → it was a restart, leave the Service running; `shell.json` shows the plugin disabled → stop the Service; the plugin source directory disappears → uninstall, keeping user data.

**Blocked by:** 11 (resolved)

**Status:** open

Spec: [standalone Linux Service](../spec.md)

- [ ] A graceful teardown of the plugin followed by a re-enable (simulated `omarchy restart shell`) leaves the Service and an active Turn running throughout.
- [ ] A graceful teardown followed by the Shell persisting the plugin as disabled stops the Service.
- [ ] A disable followed by removal of the plugin source directory uninstalls the Service and keeps user data.
- [ ] A graceful teardown with no Shell coming back (session ending) does not stop the Service by itself.
- [ ] `tests/integration/omarchy-plugin-lifetime.test.ts` covers graceful teardown, not only SIGKILL.
- [ ] Ticket 11's residuals note is updated.

## Comments

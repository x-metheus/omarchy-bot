# 02: Supervision without systemd

**What to build:** The Service runs Agent workers and the Bot Computer on hosts with no user systemd manager (containers, non-systemd distributions) by supervising owned child process groups, and still tears them down precisely by verified identity on Bot deletion, Bot Computer stop, and Service shutdown. Transient units stay preferred when a user manager exists.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] With no user manager available, a Bot Screen starts, accepts input, and stops through the Service API (Seam 1).
- [x] Service shutdown leaves no Bot Computer, worker, or application process behind.
- [x] Teardown targets only owned processes verified by identity; unrelated processes with reused PIDs are untouched.
- [x] The child environment remains explicit; nothing is imported from or exported to the host session.
- [x] With a user manager present, behavior and unit naming are unchanged.

## Comments

Without a user manager, Bot Computer and worker children lead an anchored session (`setsid` plus an `OMARCHY_BOT_SESSION_ANCHOR` marker). Teardown signals each member only after re-checking boot id and start ticks, never a numeric process group, so a reused pid and an unrelated process are left alone. Transient units stay the path when `systemd-run`, `systemctl`, and the user manager socket are present; unit names are unchanged. A failed child teardown is logged and does not skip the rest of Service shutdown. SIGTERM still detaches Screens for reattach; SIGINT `stop()` is the shutdown that reaps them.

Not done: a Service killed with SIGKILL leaves its detached workers behind. Nothing persists their session identity for the next start to reap.

Evidence: `bun test tests/integration/service-supervision.test.ts tests/integration/service-worker-supervision.test.ts tests/integration/bot-computer.test.ts tests/integration/bot-screen-sway-runtime.test.ts` — 32 pass, 4 skip, 0 fail (worker suite 6 pass including an `env -i` descendant; the other three files 26 pass, 4 skip). `bunx tsc --noEmit` clean.

## Answer

The Service supervises Bot Computer and Agent worker children as owned sessions when no user manager exists, and tears them down by verified identity on Bot deletion, Bot Computer stop, and Service shutdown. Transient units remain preferred, with the same unit names, when a user manager exists.

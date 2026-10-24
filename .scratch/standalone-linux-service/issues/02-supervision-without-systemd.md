# 02: Supervision without systemd

**What to build:** The Service runs Agent workers and the Bot Computer on hosts with no user systemd manager (containers, non-systemd distributions) by supervising owned child process groups, and still tears them down precisely by verified identity on Bot deletion, Bot Computer stop, and Service shutdown. Transient units stay preferred when a user manager exists.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] With no user manager available, a Bot Screen starts, accepts input, and stops through the Service API (Seam 1).
- [ ] Service shutdown leaves no Bot Computer, worker, or application process behind.
- [ ] Teardown targets only owned processes verified by identity; unrelated processes with reused PIDs are untouched.
- [ ] The child environment remains explicit; nothing is imported from or exported to the host session.
- [ ] With a user manager present, behavior and unit naming are unchanged.

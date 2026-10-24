# 01: Launcher-neutral `serve` entry

**What to build:** Any Launcher can start the Service on any x86_64 Linux host through one `serve` entry, not only Omarchy Shell. The generic path no longer rejects non-Omarchy distributions, creates a private 0700 runtime directory when the host provides none, holds one per-user Service lock, and exposes an unauthenticated health route that reports only liveness and version. The existing Omarchy plugin keeps working by calling the same entry until ticket 11 replaces it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] `serve` starts the Service from an installed runtime on a non-Omarchy fixture host (Seam 2).
- [ ] Omarchy plugin fixture suite stays green, now routed through `serve`.
- [ ] With no host runtime directory, the Service uses a private 0700 directory for locks, sockets, and the Bot Computer runtime.
- [ ] A second `serve` for the same user fails fast on the per-user lock and names the running Service.
- [ ] The health route answers without a token and its body contains only liveness and version (Seam 1).
- [ ] x86_64 remains enforced; non-x86_64 hosts are rejected with a clear message.

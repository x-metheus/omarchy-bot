# 07: Installer, systemd user unit, and CLI

**What to build:** One installer sets up the Service on any systemd distribution without root: it unpacks the checksum-verified runtime archive, installs a user unit, and ends by opening the one-time pairing URL. A CLI provides install, start, stop, status, pair, devices, revoke, update, uninstall, and doctor. It replaces the stale repository-root user unit.

**Blocked by:** 01, 06

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] Install on a non-Omarchy fixture home starts the Service under a user unit and opens a pairing URL (Seam 2).
- [ ] A checksum mismatch aborts install or update without extracting.
- [ ] Extraction works without host `zstd`.
- [ ] Installing when a Service already exists reuses it rather than creating a second.
- [ ] `status` reports state, address, and the last startup failure from the Service log.
- [ ] `doctor` lists each missing prerequisite and suggests lingering when no persistent login exists.
- [ ] `uninstall` removes the runtime and unit and keeps Bots, Threads, Shared Workspace, and Bot Computer profile.
- [ ] The stale repository-root unit is removed.

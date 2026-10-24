# 11: Move the Omarchy plugin into an install-only package

**What to build:** The Omarchy plugin becomes its own workspace package that works only on Omarchy and only installs the Service: enabling it runs the shared installer (or reuses an installed Service) and starts the user unit, disabling stops it, removal uninstalls the Service and keeps user data. The root manifest only points Omarchy's plugin manager at the package. Quickshell no longer parents the daemon, so Shell reloads leave Bots running, and the supervisor lifeline leaves the Service.

**Blocked by:** 07

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] `omarchy plugin add` with the root manifest installs and starts the Service through the package (Seam 2).
- [ ] Enabling on a host with a CLI-installed Service reuses it.
- [ ] Simulated Quickshell termination of the plugin leaves the Service and an active Turn running.
- [ ] Disable stops the Service; remove uninstalls it and keeps user data.
- [ ] The package refuses to run on non-Omarchy hosts.
- [ ] Dependency rules fail the build if any other package imports from the plugin package or the plugin imports Service source.
- [ ] The old launcher, supervisor, and lifeline code is removed from the Service.

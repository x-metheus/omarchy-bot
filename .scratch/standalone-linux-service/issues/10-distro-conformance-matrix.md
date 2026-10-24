# 10: Distribution conformance matrix

**What to build:** CI proves the product on many distributions: installer smoke plus real-Sway Bot Computer conformance in Ubuntu 22.04 and 24.04, Debian 12, Fedora, Arch, openSUSE, and Alpine containers using the published bundle.

**Blocked by:** 02, 04, 05, 07

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] Each distribution job installs, serves, pairs, opens a Bot Screen, captures, types, and runs `open_url`.
- [ ] Each job runs the real-Sway conformance suite against the bundle.
- [ ] Alpine (musl) passes using the non-systemd supervision path.
- [ ] A failing distribution fails the workflow with its name in the job title.

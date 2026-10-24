# 12: Support contract and docs

**What to build:** The documented product matches the shipped one: the README and product boundary state x86_64 Linux support with Omarchy, systemd, and container install paths, the SSH-tunnel and TLS remote paths, pairing, and the bundled Bot Computer.

**Blocked by:** 08, 09, 11

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] README installation covers Omarchy plugin, generic installer, and container.
- [ ] Remote access documentation covers SSH tunnel, private network, and TLS binding, and never describes unpaired access.
- [ ] The product boundary and transport security references point to ADR 0013, ADR 0014, and Computer ADR 0011.
- [ ] Startup diagnostics documentation references `status` and `doctor` instead of desktop notifications.

# 16: CLI hardening: doctor, TLS, pairing, and a real command

**What to build:** Close the shipped CLI gaps recorded in ticket 12's Comments so the Service CLI matches spec user story 13 and works with TLS-bound Services.

**Blocked by:** None (can start immediately)

**Status:** open

Spec: [standalone Linux Service](../spec.md)

- [ ] `doctor` checks, besides prerequisites: installed runtime and its checksum marker, Sway bundle ready marker, fonts, unit/launcher state, `GET /api/health` reachability, and pairing state; each failed check prints one actionable line, and the exit status is non-zero when any required check fails. It never changes the host.
- [ ] `pair`, `devices`, `revoke`, `status`, and the `install`/`update` health wait work against a TLS-bound Service (HTTPS to the configured host/port; loopback self-signed certificates accepted only for the local Service Host connection, using the host secret as today).
- [ ] `install` and `update` carry `OMARCHY_BOT_TLS_CERT`, `OMARCHY_BOT_TLS_KEY`, and `OMARCHY_BOT_TRUSTED_PROXY` (from flags or the installing environment) into the unit environment, and an explicit reconfigure path changes them on an existing install without hand-editing a drop-in.
- [ ] A fresh container started with TLS can be paired: the container prints a single-use pairing URL to stdout on first start with no Paired Device, and `docker exec … pair` works over HTTPS.
- [ ] `install` puts an `omarchy-bot` launcher on the user's PATH (`~/.local/bin`, no root), `uninstall` removes it, and `omarchy-bot --help` / `<command> --help` print usage with exit 0.
- [ ] README and ticket 12's limitations are updated to match.

## Comments

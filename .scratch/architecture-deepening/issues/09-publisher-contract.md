# 09: PublisherContract and PluginsService split

**Type:** task
**Status:** ready-for-agent
**Blocked by:** —

**What to build:** Type the daemon ↔ publisher contract once and split `apps/daemon/src/modules/plugins/plugins.ts` (971 lines) into deeper modules: provider accounts (OAuth, tokens, identity, scopes), catalog client, Service bundle provisioning, Skill install, driven by one operation table.

Decisions (settled, see [system ADR 0012](../../../docs/adr/0012-publisher-contract-is-additive.md)):
- `PublisherContract` request/response schemas live in `packages/protocol`, used by `apps/site/server/plugins.ts` and the daemon. Publisher is additive-only; daemons ignore unknown fields. Site imports the package, not relative paths.
- One operation table (action name + body schema + handler + explicit HTTP path) drives both `apps/daemon/src/api/pluginRoutes.ts` and the `manage_plugins` Agent tool; the duplicated 20-action enum goes away.
- Integration tests run the real `handlePluginCloudRequest` in-process, stubbing only provider token endpoints and `skills.sh`; delete the hand-written publisher stub (`plugin-services.test.ts:56-84`).
- Catalog: add a normalised catalog response on a **new** route; new daemons use it; keep the raw `skills.sh` passthrough route until one runtime release after daemons stop calling it.
- Prove `microsoft`/`miro` `#identify` branches unreachable with a test, then delete them and the Google-branch `tid`/`oid` claims.
- One token-metadata whitelist and one HTTPS-origin check, from the contract.

## Comments

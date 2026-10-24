# 09: PublisherContract and PluginsService split

**Type:** task
**Status:** resolved
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

## Answer

`PublisherContract` schemas live in `packages/protocol` and are imported by the site and the daemon. `PLUGIN_OPERATIONS` is the only action, method, path, and body list. `PLUGIN_DISPATCH` maps those rows and adds the daemon handler; `pluginRoutes.ts` and `manage_plugins` both call it. The duplicated action enum is gone.

The `manage_plugins` TypeBox schema is assembled in `packages/protocol` from `PLUGIN_OPERATIONS` and the keys of `PLUGIN_PROVIDERS`. `agent-contract` supplies the schema builder without importing protocol, because protocol already depends on agent-contract. The HTTP provider schema derives from the same catalog keys. The acquired tool schema is checked against exact action and provider sets; temporary additions to either canonical table prove that the regression detects drift.

`plugins.ts` is split into `CatalogClient`, `ProviderAccounts` (OAuth start, callback, token refresh, grant persistence, identity, scopes), `ServiceBundles` (provision, enable, remove, update), and `SkillInstalls`. Account records stay in the daemon store and are mutated by those modules.

Integration tests call the real `handlePluginCloudRequest` and stub only provider token endpoints and skills.sh. New daemons read `catalog/normalised`; the raw skills.sh passthrough remains. `identifyAccount` refuses Microsoft and Miro before any fetch, and `ProviderAccounts.authorize` for Microsoft records no publisher route. Google identity stored by the publisher is `{ subject }` only. `HttpsOrigin` and `TOKEN_METADATA_KEYS` are defined once in the protocol package.

`bun run typecheck` passed. Publisher, plugin service, skill, shared plugin, native MCP, and MCP package integration tests passed. Review of `24fe99b` is APPROVED.

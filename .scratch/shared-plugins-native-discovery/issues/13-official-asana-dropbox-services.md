# 13: Deliver official Asana and Dropbox Services

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** Asana and Dropbox each provide an official, account-aware Service with complete provider-owned resources and grouped management from both the panel and Bot tools. Their distinct registration and authorization rules are honored rather than treated as interchangeable generic API connections.

**Blocked by:** [10: Deliver the first complete official Microsoft Service](10-official-microsoft-service.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 3, 4, 5, 6, 7, 8, 14, 76. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Asana uses the provider's applicable official MCP app registration, endpoint, grant, and workspace flow. Verify actual tool entitlements and paid-plan limitations where relevant; do not substitute an ordinary API app or assume its tokens can call other surfaces.
- [ ] Dropbox uses the current official MCP integration with the appropriate application registration, account/team policy, consent, and access/refresh behavior. Report provider restrictions on client onboarding rather than silently substituting a third-party server.
- [ ] For every named provider, verify first-party source, exact MCP endpoint/package, supported account/region/consent conditions, and whether official companion Skills exist. Install complete official companion resources when published; do not invent a Skill when none exists or accept a similarly named third-party package as official.
- [ ] Use the existing full Service interface for both Client and Bot add/inspect/enable/disable/remove and authorization initiation. Dedicated official connections and Skills operate as one unit, appear in Service details, and do not duplicate independent custom entries.
- [ ] Preserve multiple-account identity, shared grants needed by other Services, and separately installed custom resources. Credentials stay out of public state, model-visible management results, logs, and shared project files; native/provider authorization remains user-controlled.
- [ ] Migrate each provider's existing relevant account/configuration state without discarding local identity or enablement. Remove obsolete per-provider REST substitutes and duplicate MCP/Skill registration paths as each provider is cut over; do not leave a hidden fallback.
- [ ] Exercise each named provider's lifecycle and failure conditions using deterministic fixtures at the primary daemon seam, plus browser-visible Service behavior and real Pi resource execution. A group ticket is not complete after testing only one provider.
- [ ] Record actual first-party eligibility findings and live authorization/representative tool-call evidence separately for each applicable provider. Missing registration, credentials, or consent is an explicit unmet live-verification prerequisite, not a passing fixture or permission to narrow the group silently.
- [ ] Update the provider-facing support notes and Service details to describe real limits and pending runtime/auth states. Do not add Agent workers, alter user-level configuration, or run host-global setup/update flows.

## Comments

### 2026-09-12 — Publisher registration remains required

The registry uses official Asana v2 MCP and Dropbox MCP endpoints without REST business fallbacks. Asana requires an MCP app, not an ordinary API app; Dropbox requires a publisher Scoped access / Full Dropbox application, with production/team policy as applicable.

No corresponding publisher registration and consenting workspace/account is available. Live identity, business tools, disable/re-enable, removal, and disconnect remain unverified rather than being inferred from cards or OAuth fixtures.

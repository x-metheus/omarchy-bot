# 12: Deliver official Notion, GitHub, and Linear Services

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** Notion, GitHub, and Linear each use the complete official Service model rather than only an account card. The user or Bot can connect and manage each one, obtain its official tools and any official Skill guidance, and distinguish working access from workspace, organization, or consent restrictions.

**Blocked by:** [10: Deliver the first complete official Microsoft Service](10-official-microsoft-service.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 3, 4, 5, 6, 7, 8, 14, 76. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Notion completes its currently documented official MCP authorization and workspace access path, including provider-supported registration metadata where applicable; do not replace it with an assumed generic OAuth flow.
- [ ] GitHub completes its current official MCP access path and reports applicable repository, organization, SSO, and entitlement constraints. A valid account identity does not by itself prove access to every repository tool.
- [ ] Linear completes its current official MCP and workspace-grant path with the documented account/consent behavior. Do not assume ordinary API token semantics without confirming the official MCP contract.
- [ ] For every named provider, verify first-party source, exact MCP endpoint/package, supported account/region/consent conditions, and whether official companion Skills exist. Install complete official companion resources when published; do not invent a Skill when none exists or accept a similarly named third-party package as official.
- [ ] Use the existing full Service interface for both Client and Bot add/inspect/enable/disable/remove and authorization initiation. Dedicated official connections and Skills operate as one unit, appear in Service details, and do not duplicate independent custom entries.
- [ ] Preserve multiple-account identity, shared grants needed by other Services, and separately installed custom resources. Credentials stay out of public state, model-visible management results, logs, and shared project files; native/provider authorization remains user-controlled.
- [ ] Migrate each provider's existing relevant account/configuration state without discarding local identity or enablement. Remove obsolete per-provider REST substitutes and duplicate MCP/Skill registration paths as each provider is cut over; do not leave a hidden fallback.
- [ ] Exercise each named provider's lifecycle and failure conditions using deterministic fixtures at the primary daemon seam, plus browser-visible Service behavior and real Pi resource execution. A group ticket is not complete after testing only one provider.
- [ ] Record actual first-party eligibility findings and live authorization/representative tool-call evidence separately for each applicable provider. Missing registration, credentials, or consent is an explicit unmet live-verification prerequisite, not a passing fixture or permission to narrow the group silently.
- [ ] Update the provider-facing support notes and Service details to describe real limits and pending runtime/auth states. Do not add Agent workers, alter user-level configuration, or run host-global setup/update flows.

## Comments

### 2026-09-12 — Official routes and explicit live prerequisites

Provider configuration and published companion sources are recorded in `packages/protocol/src/pluginProviders.ts`; Services use native official MCP resources and the shared grouped lifecycle. Native dynamic-registration paths remain distinct from the optional publisher OAuth routes.

Live acceptance is blocked by unavailable consenting Notion/Linear workspaces and a registered publisher GitHub OAuth App/account grant. Workspace policy, repository/organization approval, SSO, and tool-specific permissions still apply. Registry entries and controlled lifecycle tests do not prove those providers' business operations.

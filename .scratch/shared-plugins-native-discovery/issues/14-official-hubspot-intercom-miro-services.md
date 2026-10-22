# 14: Apply official-only behavior to HubSpot, Intercom, and Miro

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** HubSpot, Intercom, and Miro are either genuinely usable through their applicable provider-official integrations or explicitly shown as unavailable with a concrete reason. Existing locally maintained behavior is not left running behind an official Service label, and the user's unrelated accounts and custom alternatives remain intact.

**Blocked by:** [10: Deliver the first complete official Microsoft Service](10-official-microsoft-service.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 3, 4, 5, 6, 7, 8, 14, 76. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] HubSpot uses its current official MCP-specific application, authorization, identity, and tool-permission model. Do not infer permission coverage from a generic CRM API registration or hardcoded substitute scopes.
- [ ] Intercom uses its current official MCP authorization and supported regional endpoint behavior. Unsupported regions and token-refresh limitations are shown accurately; do not route an unsupported regional account to another endpoint as a silent workaround.
- [ ] Re-evaluate Miro against current first-party sources. If an applicable official MCP exists, deliver the full official Service lifecycle and resources. If it does not, show the precise unavailable condition and remove the old locally maintained REST business-tool route; preserve relevant stored account identity and unrelated user data.
- [ ] An unavailable official Service must remain distinct from a broken configured connection and from user-supplied custom MCP/Skills. Do not block the user from adding a third-party alternative under the custom categories.
- [ ] For every named provider, verify first-party source, exact MCP endpoint/package, supported account/region/consent conditions, and whether official companion Skills exist. Install complete official companion resources when published; do not invent a Skill when none exists or accept a similarly named third-party package as official.
- [ ] Use the existing full Service interface for both Client and Bot add/inspect/enable/disable/remove and authorization initiation. Dedicated official connections and Skills operate as one unit, appear in Service details, and do not duplicate independent custom entries.
- [ ] Preserve multiple-account identity, shared grants needed by other Services, and separately installed custom resources. Credentials stay out of public state, model-visible management results, logs, and shared project files; native/provider authorization remains user-controlled.
- [ ] Migrate each provider's existing relevant account/configuration state without discarding local identity or enablement. Remove obsolete per-provider REST substitutes and duplicate MCP/Skill registration paths as each provider is cut over; do not leave a hidden fallback.
- [ ] Exercise each named provider's lifecycle and failure conditions using deterministic fixtures at the primary daemon seam, plus browser-visible Service behavior and real Pi resource execution. A group ticket is not complete after testing only one provider.
- [ ] Record actual first-party eligibility findings and live authorization/representative tool-call evidence separately for each applicable provider. Missing registration, credentials, or consent is an explicit unmet live-verification prerequisite, not a passing fixture or permission to narrow the group silently.
- [ ] Update the provider-facing support notes and Service details to describe real limits and pending runtime/auth states. Do not add Agent workers, alter user-level configuration, or run host-global setup/update flows.

## Comments

### 2026-09-12 — Official-only configuration; live authorization blocked

HubSpot retains its MCP-specific auth-app requirement. Intercom exposes separate US/EU official MCP Services and does not claim Australian-workspace support or customer-visible replies. Miro retains secure metadata/identity validation instead of bypassing inconsistent publisher metadata.

No HubSpot MCP auth-app grant, region-matched Intercom workspace consent, or Miro board/team consent is available. Miro's secure live authentication/identity behavior and all three providers' business/lifecycle scenarios remain open. Controlled native HTTP/PKCE execution is runtime evidence only.

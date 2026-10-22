# 11: Deliver official Google Drive, Gmail, and Calendar Services

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** Google Drive, Gmail, and Google Calendar work as official Service integrations through the established bundled lifecycle. Users and Bots can manage each Service, identify the correct shared provider account, and see the real official capabilities and restrictions without locally maintained REST tools being silently added.

**Blocked by:** [10: Deliver the first complete official Microsoft Service](10-official-microsoft-service.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 3, 4, 5, 6, 7, 8, 14, 76. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Complete all three Services: Drive, Gmail, and Calendar. Confirm their current official MCP surfaces and any official companion Skills rather than assuming endpoint strings in the old registry prove live availability.
- [ ] Preserve provider account sharing while making Service-specific availability, consent, and enabled components understandable. Verify switching the intended account and disabling one Service do not revoke or silently disable unrelated Services.
- [ ] Check official support for the advertised file, mail/draft/send, and calendar operations. If an operation is absent from official MCP or outside the user's grant, show the limitation; remove locally written REST augmentation rather than claiming unchanged coverage.
- [ ] For every named provider, verify first-party source, exact MCP endpoint/package, supported account/region/consent conditions, and whether official companion Skills exist. Install complete official companion resources when published; do not invent a Skill when none exists or accept a similarly named third-party package as official.
- [ ] Use the existing full Service interface for both Client and Bot add/inspect/enable/disable/remove and authorization initiation. Dedicated official connections and Skills operate as one unit, appear in Service details, and do not duplicate independent custom entries.
- [ ] Preserve multiple-account identity, shared grants needed by other Services, and separately installed custom resources. Credentials stay out of public state, model-visible management results, logs, and shared project files; native/provider authorization remains user-controlled.
- [ ] Migrate each provider's existing relevant account/configuration state without discarding local identity or enablement. Remove obsolete per-provider REST substitutes and duplicate MCP/Skill registration paths as each provider is cut over; do not leave a hidden fallback.
- [ ] Exercise each named provider's lifecycle and failure conditions using deterministic fixtures at the primary daemon seam, plus browser-visible Service behavior and real Pi resource execution. A group ticket is not complete after testing only one provider.
- [ ] Record actual first-party eligibility findings and live authorization/representative tool-call evidence separately for each applicable provider. Missing registration, credentials, or consent is an explicit unmet live-verification prerequisite, not a passing fixture or permission to narrow the group silently.
- [ ] Update the provider-facing support notes and Service details to describe real limits and pending runtime/auth states. Do not add Agent workers, alter user-level configuration, or run host-global setup/update flows.

## Comments

### 2026-09-12 — Controlled lifecycle proof; live Google access blocked

The three real-daemon `plugin-services.test.ts` cases passed: multi-account Service removal with shared companion ownership, failed multi-companion staging followed by repaired executable content, and reduced-scope reauthorization withdrawing unauthorized components while retaining identity and independent resources. Publisher/userinfo responses are controlled fixtures; they are not Google business calls.

Live acceptance needs a registered publisher Web OAuth client, enabled Workspace APIs/MCP services, and a consenting eligible Google account. Those credentials/grants are unavailable. No REST business fallback is retained as a substitute.

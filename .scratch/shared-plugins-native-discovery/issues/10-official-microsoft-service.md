# 10: Deliver the first complete official Microsoft Service

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** A user or Bot adds the applicable official Microsoft Work IQ integration as a Service: official MCP tools, existing official companion Skills, account authorization, and one lifecycle. The product reports genuine eligibility and capability limits instead of silently falling back to its old Graph request tools. This is the working Service pattern consumed by the later provider slices.

**Blocked by:** [01: Manage shared Skills through native discovery](01-native-shared-skill-management.md); [07: Connect remote MCPs with real authorization and status](07-remote-mcp-and-authorization.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Confirm the selected Microsoft official package, endpoint, companion Skills, exact source/revision, supported account types, tool scope, licensing surface, and consent requirements against first-party sources. The researched Work IQ package is a starting point, not a claim that all Graph features or personal accounts are supported.
- [ ] The user can inspect and add the Service from the existing Service category, complete applicable authorization, and perform a bounded official MCP action with its official Skill guidance available. Include complete provider-published companion resources; do not write a substitute business Skill or REST fallback.
- [ ] Represent the official package's real scope honestly. Do not present a broad Microsoft bundle as independently isolated mail/calendar/file permissions or capabilities if the provider/runtime does not support that separation.
- [ ] Enable, disable, and remove the Service as one unit covering its dedicated connections and Skills. Show component provenance and failures in details but do not duplicate Service-owned components as independent custom MCP/Skill installations.
- [ ] Preserve multiple-account identity and provider account pooling. Removing one Service must not remove unrelated independent Skills, components still owned by another Service, or another Service's grant; disabling a component is not remote account revocation.
- [ ] Expose Service inventory/detail, add, enable/disable, remove, and authorization-initiation capabilities to Bots through the same management interface. Maintain autonomy, native approvals, user-performed consent, secret confidentiality, and truthful pending-authorization/reload results.
- [ ] Use the chosen Pi runtime/bundle-loading and native Skill mechanisms without duplicate registered tools or duplicate Skill aliases. Reuse the working Service lifecycle as the interface for future provider tickets rather than building provider-specific parallel management systems.
- [ ] Migrate existing relevant Microsoft identities and settings conservatively. Retire the corresponding locally maintained Graph business-tool route. Unsupported account types or missing official operations become explicit unavailable/limited conditions, not silently retained REST behavior or erased account records.
- [ ] A controlled full-bundle provider fixture exercises account selection, composition, ownership, failure, and grouped lifecycle through public Client/Bot paths. Real Pi must use actual loaded resources; a fake account or schema-only check is not proof of provider access.
- [ ] Perform and record a separate live Microsoft consent and representative official tool call with the necessary tenant/account. If registration, license, credentials, or consent is unavailable, mark that acceptance evidence unmet rather than fabricate success or substitute a different service.
- [ ] Verify actual Service panel behavior on desktop and narrow layouts, including grouped details, no duplicate custom entries, authorization actions, and preservation of the ongoing Thread/draft. Update official-only, credential, and runtime documentation for the first real integration.

## Comments

### 2026-09-12 — Official configuration implemented; live tenant required

The Service uses official WorkIQ and its published companion Skill, not a Microsoft Graph business fallback. Production Chromium displayed the organizational Microsoft 365/Copilot licensing, tenant-admin consent, provisioning, native callback, and secure-discovery requirements from the provider registry.

No authorized, provisioned WorkIQ tenant/account is available in this environment. Live consent, identity, tool use, lifecycle, and tenant-policy acceptance remain unverified. Personal accounts and old Graph grants are not counted as equivalent evidence.

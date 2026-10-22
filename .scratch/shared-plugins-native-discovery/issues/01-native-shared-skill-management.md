# 01: Manage shared Skills through native discovery

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** A user can install through the existing catalog, inspect, enable, disable, and remove an independent Skill in the Shared Workspace, see native file edits reflected in the plugin panel, and use the resulting Skill from a Pi Bot. Existing managed Skills move to this native-discovery model without losing content or being loaded twice. This establishes the shared Skill lifecycle used by later Bot-management and default-creator slices; it does not wait for a new MCP runtime.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

**Spec coverage:** User Stories 36, 37, 42, 43, 44, 51, 52, 53, 54, 55, 56, 57, 58, 72, 73, 74, 80. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] The existing Skill panel and public operations use native workspace discovery as the effective source for independent Skills. Complete installed content, provenance, requested enablement, native applicability, and invalid-resource conditions are represented honestly; application-data records do not silently overwrite the native source.
- [ ] A workspace Skill added, edited, atomically replaced, disabled, re-enabled, or removed outside the Client is reflected while the panel is open and after daemon restart. A removed entry is not resurrected from stale managed state, and malformed intermediate content is reported without rewriting the user file.
- [ ] Client installation and management update the same native resources that Pi loads. Disabling removes the Skill from effective discovery after the supported reload; re-enabling restores it without losing content. Removal does not delete a separate source directory, inherited user resource, or unrelated work.
- [ ] Existing managed Skill contents, companion resources, source identity, and enablement migrate conservatively. A same-name native resource is preserved and reported for resolution instead of being overwritten. Retire the old duplicate managed injection for each migrated resource rather than keeping synthetic aliases.
- [ ] Preserve Pi native user/project discovery and precedence, explicit Thread working directories, and the distinction between a working directory and a sandbox. Do not rewrite user-level Agent settings or impose a new global same-name policy.
- [ ] Two Pi Bots using the Shared Workspace can discover and meaningfully use the same independent Skill while keeping separate Native Sessions. Deleting one Bot preserves shared Skills and their content.
- [ ] The plugin panel stays within the existing desktop dialog and narrow-screen presentation, updates without losing the selected Thread or Composer draft, and identifies invalid or pending-reload conditions instead of calling every discovered file usable.
- [ ] Use the real-daemon public interface and external edits in isolated homes for regressions covering content preservation, deletion, malformed edits, and restart convergence. Verify actual Pi resource use and the real browser surface separately; do not substitute internal map or field-forwarding assertions.
- [ ] Keep all setup and teardown project-scoped and host-safe. Update affected Skill-loading and ownership documentation as this behavior lands; only necessary local prefactoring belongs in this slice.

## Comments

### 2026-09-12 — Implementation and observed evidence

Native shared discovery, complete companion preservation, enablement, removal, conflict handling, local modification protection, and restart behavior are covered through the daemon-facing integration seams in `shared-plugins.test.ts` and `plugin-skills.test.ts`. Real Pi created `release-summary` in the canonical workspace; another Bot consumed its script, and deleting the creator Bot retained the shared resource.

Production Chromium displayed shared/native provenance and update attention at desktop and 390px width. The current Thread and unsent Composer draft survived dialog use, Bot-originated changes, updates, and private daemon restart. This is not a Tauri claim. The checklist remains an acceptance inventory, not a blanket all-green declaration.

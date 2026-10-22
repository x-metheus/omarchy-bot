# 02: Let Bots search and manage catalog Skills

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** A user can ask a Bot to find a Skill on skills.sh, inspect it, install it, or manage an installed Skill. Bot actions and the Client operate the same shared environment: the panel shows the result and another Bot can use the installed Skill. Management is an ordinary Agent Tool Call, not a new approval workflow.

**Blocked by:** [01: Manage shared Skills through native discovery](01-native-shared-skill-management.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 15, 20, 21, 22, 23, 24, 25, 26, 27, 28. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Provide Bot-facing capabilities for inventory and detail inspection, skills.sh search, exact catalog installation, and independent Skill enable, disable, and remove operations. Reuse the existing shared plugin-management interface rather than maintaining separate Bot and Client implementations.
- [ ] Search and detail results identify the actual source, selected Skill, and available content so the Bot can inspect before acting. Preserve existing catalog pagination and bounded-search semantics; an ambiguous or stale identity fails rather than installing a guessed replacement.
- [ ] A management action follows the existing Tool Call, Turn cancellation, and error conventions. Return observed installation, failure, or pending-reload status, not an unconditional success or a private conversation-only record.
- [ ] Bot actions are autonomous under the accepted policy: no extra Omarchy Bot confirmation gate is added. Native Agent approvals still apply, and tool invocation is attached to the legitimate active Bot/Turn rather than accepting unrelated stale requests.
- [ ] An installed catalog Skill and complete companion resources appear in the panel and are usable by another Pi Bot after the actual native reload boundary. Bot disable/remove operations update the same files and inventory as Client operations.
- [ ] A Bot can inspect source, effective applicability, and management errors without receiving stored credentials or unrelated user secrets. A catalog result is not presented as an installed or verified capability.
- [ ] Exercise the whole Bot-management-to-shared-use path through the real daemon using a deterministic catalog/source fixture, then use actual Pi for a bounded successful consumer task. Keep malformed identity and interrupted installation regressions behavioral.
- [ ] Verify a browser scenario where Bot-initiated installation and later removal update the open panel without navigating away or discarding a Composer draft. Document the exposed management capabilities without treating each verb as a required separate tool.

## Comments

### 2026-09-12 — Real Bot management proof

A real Pi model Turn invoked `manage_plugins` search, inspection, installation, disable, enable, and final inventory inspection against a controlled catalog/well-known source. It executed the installed `fixture-arithmetic/scripts/calculate.js 35`; the output file contained `amount=42`. Native Session receipts and public inventory confirmed the operations and enabled, unmodified final Skill.

This exercises the real Bot/daemon/native-file path, not production skills.sh availability. Explicit GitHub source acquisition is separately recorded in ticket 03. No application-specific approval prompt or business MCP replacement was added.

# 05: Share native Skill discovery and creation across Agents

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** The same portable Skill and locally provisioned official Creator can be discovered and used by Pi, Codex, and Claude native clients operating in the Shared Workspace. The product shows source and applicability without inventing a shared precedence rule. This adds native-client compatibility evidence, not Codex or Claude Bot workers.

**Blocked by:** [04: Provide default Skill creation in a Pi-only environment](04-default-pi-only-skill-creation.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 33, 39, 45. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Expose shared Skill content through each target client's actual supported native discovery mechanism. Do not maintain divergent per-Agent or per-Bot copies; use supported sharing/linking behavior and verify companion-resource resolution.
- [ ] Preserve each client's native project/user precedence, trust, and same-name behavior. Pi project precedence, Codex possible same-name coexistence, and Claude personal/project behavior must not be replaced with one invented policy. Do not rewrite user-level resources.
- [ ] The default official Creator is discoverable in the target native clients and supports a real local creation task without requiring another Agent's proprietary CLI pipeline for essential steps. Host-specific optional evaluation tooling is not a universal creation prerequisite.
- [ ] Use an actual portable Skill created in the shared environment to complete a bounded task under Pi and the target non-Pi clients; separately perform creation under the target clients. A loader listing or common file syntax alone is not proof of usable authoring or Skill behavior.
- [ ] The panel identifies origin, duplicate/shadowed applicability, and meaningful compatibility/dependency limitations without presenting arbitrary specialized Skills as universally executable.
- [ ] Keep Pi-only default creation independently usable. External-client installation/login is required only for its separate compatibility verification, never to let a Pi user create Skills.
- [ ] Do not add Codex/Claude Bot workers, Native Session adapters, Agent Readiness claims, or product controls for those unimplemented backends.
- [ ] Record the exact client versions, shared discovery behavior, effective precedence examples, and observed task results using isolated homes/workspaces. If a client, model access, or other prerequisite is unavailable, report that verification as unmet rather than passed; do not reduce the cross-Agent acceptance claim silently.
- [ ] Update native Skill compatibility and default-creator documentation based on the exercised behavior, and retain focused regressions only where they defend an actual portability or preservation boundary.

## Comments

### 2026-09-12 — Native discovery passed; model acceptance blocked

Codex CLI 0.154.0 `app-server --stdio` successfully returned the Pi-created `release-summary` and shared Creator from native `skills/list` in an isolated home and the same workspace. The created Skill resolved to the same physical file, not a copied or synthetic alias. Real cross-Bot Pi creation/use is recorded in ticket 04.

Native Codex model creation/use remains unverified: Codex authentication is unavailable. Claude's executable and credentials are unavailable. These are explicit prerequisites for the remaining native-client authoring scenarios; configuration discovery is not counted as model execution.

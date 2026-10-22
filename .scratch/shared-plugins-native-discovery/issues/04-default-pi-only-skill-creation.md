# 04: Provide default Skill creation in a Pi-only environment

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** A fresh Pi Bot can immediately create a useful local Skill without the user first installing a creator or installing Codex or Claude. Omarchy Bot locally supplies a complete official Creator; Pi does the authoring through its existing tools. Another Pi Bot discovers and uses the created Skill, and the plugin panel displays it without a registration or publish action.

**Blocked by:** [01: Manage shared Skills through native discovery](01-native-shared-skill-management.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 32, 33, 34, 35, 38, 40, 41. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Select a compatible first-party Skill Creator and record its exact source and revision. The parent identifies OpenAI and Anthropic sources but does not mandate a vendor. A similarly named third-party catalog item or model-only promise is not an acceptable substitute.
- [ ] Provision the complete official Creator and necessary companion resources as part of the default local Bot environment before the first creation request. Do not rely on Pi already shipping it, user catalog installation, or an optional setup link. Do not develop a replacement Creator.
- [ ] Demonstrate the complete default workflow in an isolated Pi-only environment with no preinstalled creator and no Codex or Claude executable, configuration, credentials, or invocation. Select a Creator whose necessary authoring steps work with Pi and ordinary supported script runtimes; reject a required dependency on another Agent CLI.
- [ ] Use existing native Skill loading and Pi file/execution capabilities. Do not add a dedicated create-skill service/API, alternate model runtime, private Skill format, authoring registry, or draft/publish state machine.
- [ ] A concrete creation task produces complete Skill instructions and any necessary resources in the shared native discovery area. An initializer template or placeholders do not count as completion. Check the task result; metadata validation alone is not behavior or safety evidence.
- [ ] The created Skill is discovered and appears in the panel as local shared content, without remote upload or a manual refresh/registration requirement. It has local provenance and no fabricated upstream update source.
- [ ] A different Pi Bot uses the created Skill for a bounded task with verifiable output. Deleting the creating Bot leaves the Skill and its usable resources intact.
- [ ] Required ordinary script dependencies are supplied or checked using repository-managed or temporary host-safe mechanisms. No host package manager, global Agent installation, or graphical-session mutation is allowed to make the scenario pass.
- [ ] Use a real Pi creation-and-consumption smoke scenario for acceptance, plus the existing high-level discovery tests for state and preservation. Verify the panel outcome. A fake worker or an already manually provisioned creator does not prove the default capability.
- [ ] Document local default provisioning versus upstream authorship explicitly. This slice does not depend on Bot catalog tools or explicit-source UI, and it does not install other Agent clients as user prerequisites.

## Comments

### 2026-09-12 — Pi-only creation and packaged resources

Real Pi SDK 0.84.4 model execution used the locally provisioned official OpenAI Creator's `init_skill.py` and `quick_validate.py`, then completed a working `release-summary` Skill and Python helper. Its first case produced `passed=2 failed=1`; an independent Bot produced `passed=1 failed=2` using the same shared resource. The isolated authoring PATH supplied Bun, Node, and Python, without Codex or Claude.

The packaged runtime separately executed the complete initializer and validator with bundled PyYAML. Ordinary Python 3 remains required; the native MCP OAuth lock helper additionally needs Node on Linux/Bun. No host package installation was performed.

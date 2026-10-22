# 03: Install complete Skills from explicit sources

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** A user or Bot can install an independent Skill from an explicitly selected repository, Skill URL, or local directory without requiring a skills.sh listing. The panel shows its true source, and a Bot can use all required companion files. Invalid sources fail without damaging an existing installation or the original local source.

**Blocked by:** [02: Let Bots search and manage catalog Skills](02-bot-skill-catalog-management.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 29, 30, 31. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Extend the same Client and Bot installation entry points to accept a specific repository Skill, supported Skill URL, or local directory alongside existing catalog entries. Require an unambiguous selected Skill rather than guessing among similarly named directories.
- [ ] Preserve the complete selected Skill and required scripts, references, assets, and binary content. An imported local directory remains intact outside the installed copy; discovered live links are not treated as disposable remote caches.
- [ ] Record real source type, identity, and revision/update eligibility. Do not invent a remote origin for local content or confuse a provider-official default Creator with a third-party item sharing its name.
- [ ] Preserve existing source-identity and unsafe-archive guarantees, including rejection of unsafe linked entries and missing required content. A failed install leaves no apparently ready partial Skill, does not replace an existing working revision, and does not poison a later valid install.
- [ ] The resulting native Skill is visible in the shared panel and actually usable by another Bot, with source details and errors available through both the public interface and Bot inspection tools.
- [ ] Cover repository, URL, and local imports through high-level installation scenarios with deterministic isolated sources. Prove a required companion resource is used in a meaningful task; do not assert only that a directory exists.
- [ ] Verify source-selection and failure presentation in the actual desktop/narrow Client. No remote publication, creator service, host package installation, or global Agent configuration changes are introduced.

## Comments

### 2026-09-12 — Complete source and preservation proof

An actual GitHub materialization of `openai/skills`, selected path `skills/.system/skill-creator`, resolved revision `49f948faa9258a0c61caceaf225e179651397431`. The installed initializer matched the source helper byte-for-byte. A subsequent local customization caused reinstall to reject with 409; restart retained both the edit and modified state.

A private legacy-layout migration retained complete Skill content. Changed upstream content could not overwrite that unverified migration baseline, including after another service restart. Controlled well-known installation and bundled script execution also passed through a real Bot in ticket 02.

# AI teammate workspace

**Status:** completed

## Authority

- [Feature specification](./spec.md)
- [Superseding ordered transcript specification](../ordered-rich-transcript/spec.md)
- [Accepted workspace design](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md)
- Bot and Agent decision (ADR 0002)
- Ordered transcript decision (ADR 0007)
- [Workspace language](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/workspace/CONTEXT.md)
- [Agent integration language](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/agent-integration/CONTEXT.md)
- [Computer control language](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/computer-control/CONTEXT.md)

The specification and accepted design define product behavior. Context documents define canonical terms. ADRs record durable trade-offs. Resolved tickets record the delivered slices and must not override those authorities.

## Resolved tickets

- [01 — Separate Agents from user-created Bots](./issues/01-separate-agents-from-user-created-bots.md)
- [02 — Chat through a user-created Bot](./issues/02-chat-through-a-user-created-bot.md)
- [03 — Steer active Bot work](./issues/03-steer-active-bot-work.md)
- [04 — Navigate Thread history and preserve window drafts](./issues/04-thread-history-and-window-drafts.md)
- [05 — Send and revisit managed attachments](./issues/05-managed-attachments.md)
- [06 — Dictate with Voxtype](./issues/06-voxtype-dictation.md)
- [07 — Edit Bot Profiles and avatars](./issues/07-bot-profiles-and-avatars.md)
- [08 — Archive and restore Bots safely](./issues/08-archive-and-restore-bots.md)
- [09 — Surface background attention in the Sidebar](./issues/09-sidebar-attention.md)
- [10 — Replace the Computer console with contextual control](./issues/10-contextual-computer-sheet.md)
- [11 — Permanently delete Bot-owned data](./issues/11-permanent-bot-deletion.md)
- [12 — Contract the legacy runtime model](./issues/12-contract-legacy-runtime.md)
- [13 — Complete responsive, accessibility, and visual QA](./issues/13-responsive-accessible-visual-qa.md)

## Cross-cutting invariants

- A Bot is a persistent user-created or conservatively preserved assistant. An Agent is a Pi, Claude, or Codex execution backend. Enabled Agent inventory is never a Bot.
- Migration retains user-owned conversation, profile, and configuration data, records `user_created`, `legacy_conversation`, or `legacy_inventory` provenance, deletes only proven inventory, and preserves ambiguity.
- Each Agent adapter returns the sole `AgentCapabilityInventory` used for steering, abort, session deletion, Thread actions, attachment modalities, and native event families.
- Avatar Recipes use the sole current renderer `dicebear-core@10.7.0+styles@10.6.0`; upgrades replace unsupported recipes with deterministic current defaults instead of shipping compatibility renderers.
- Create and History use desktop Dialogs and narrow BottomSheets. Computer uses a desktop drawer and narrow BottomSheet.
- Emergency control is absent while idle and immediately available while computer input is active or stopped.
- Browser E2E is role-first and treats accessible roles and visible names as the public user seam.

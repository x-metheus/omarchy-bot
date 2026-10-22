# 09: Let Bots manage custom MCP connections

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** A user can ask a Bot to inspect, add, edit, check, enable, disable, or remove a custom MCP connection. The same native configuration and panel state used by the Client change, and a subsequent supported runtime can use the connection. The Bot reports authorization/reload needs honestly without exposing credentials.

**Blocked by:** [07: Connect remote MCPs with real authorization and status](07-remote-mcp-and-authorization.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 18, 19, 22, 23, 24, 25, 26, 27. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Expose inventory/detail, create/update, connection-check, enable/disable, and remove capabilities through the existing Agent Tool Call and plugin-management seams. Reuse the Client's management logic; do not implement a separate Bot-owned configuration database.
- [ ] Exercise both the working local stdio and remote MCP paths. Bot-provided definitions preserve supported options and existing write-only secret values or safe references without returning stored credentials for inspection.
- [ ] Bot management is autonomous under the accepted policy while retaining legitimate active Turn context, cancellation, native approvals, and provider authorization. Do not insert a new product-level prompt or allow stale/unrelated Tool Calls to mutate the environment.
- [ ] When authorization is required, return the real user-facing next action; do not fabricate completion or try to grant consent for the user. Saved, connected, failed, and awaiting-reload results remain distinct.
- [ ] Bot mutations appear in the open panel and are the same changes that native configuration discovery observes. After the applicable reload, another Pi Bot can use the added connection; disabling/removing it stops subsequent availability without killing unrelated in-flight work.
- [ ] Demonstrate a real local MCP task effect after Bot-driven setup, not only a fake-worker acknowledgment. Verify one call does not execute via both the old daemon route and the selected Pi extension.
- [ ] Cover malformed definitions, actual check failures, cancelled management, and a removal that leaves unrelated connections intact through the real-daemon seam. Inspect observable outcomes rather than helper forwarding.
- [ ] Browser-check the conversation-to-panel update and authorization/error presentation. Update Bot tool capability documentation and preserve credential confidentiality in ordinary Tool Call rendering.

## Comments

### 2026-09-12 — Real model-driven MCP management

A real Pi Turn invoked `save_mcp`, `check_mcp`, disable, enable, `remove_mcp`, and inventory inspection through `manage_plugins`. The native check reported connected with one tool. Public inventory then contained only the pre-existing connection; the removed entry did not resurrect after private daemon restart. Native Session receipts confirmed the management calls.

The already-running business gateway retained its earlier native configuration during this workflow; that was not relabeled as immediate hot reload. The browser's Check operation also exercised the real daemon/native control seam. Remote consent remains a separate authorization action.

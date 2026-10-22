# 08: Synchronize shared MCP entries across native client formats

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** A custom MCP added or edited in the panel, by a Bot, or in a native project file becomes the same shared connection in compatible Pi, Codex, and Claude configuration. Conflicting edits and fields that cannot be represented are preserved and shown, not silently normalized away. Restarts recover the same effective inventory.

**Blocked by:** [07: Connect remote MCPs with real authorization and status](07-remote-mcp-and-authorization.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Project-level shared custom MCP additions, edits, removals, and representable enablement changes converge across the actual native formats supported by Pi's extension, Codex, and Claude. Do not assume a universal MCP config file or merely link incompatible JSON and TOML formats.
- [ ] Keep stable shared-entry identity and distinguish shared fields from client-specific settings. Preserve unrelated entries and richer native options; never erase unrepresentable data to claim a successful projection.
- [ ] Recognize direct edits and native commands as first-class input, including atomic saves and deletions. Panel writes and external edits must not oscillate, duplicate entries, or resurrect a removal from stale managed state.
- [ ] Conflicting simultaneous/native representations and unsupported projection fields produce actionable status with original file content retained. A later nonconflicting repair can reconcile normally without resetting the whole environment.
- [ ] Preserve each Agent's native user-level configuration and precedence. Do not write user-level settings, change provider OAuth credentials across clients, or grant project trust on behalf of an external client.
- [ ] Malformed/intermediate files remain untouched and visibly invalid. Reconcile on startup as well as live change detection so missed events do not permanently desynchronize public inventory and native resources.
- [ ] The panel and public inspection distinguish source, effective applicability, synchronized versus conflicted configuration, and pending runtime reload. Do not promise immediate active-session tool changes from a successful file write.
- [ ] Through the primary daemon seam, drive Client/public edits and external file edits and observe native configuration meaning and real consumer behavior. Cover concurrent edits, unrepresentable options, credential non-disclosure, deletion, correction, and restart without testing watcher internals.
- [ ] Smoke-test native discovery and a bounded MCP tool use under the target real clients with isolated configuration. No Codex/Claude Bot workers are added; missing native-client prerequisites are recorded as unverified, not replaced with format-only claims.
- [ ] Update compatibility documentation to describe real supported mappings and limitations rather than a fictional universal configuration schema.

## Comments

### 2026-09-12 — Configuration and Pi execution; external calls blocked

Daemon integration scenarios cover native JSON/TOML reconciliation, client-specific preservation, conflicts and repair, credential non-disclosure, deletion, and restart. Real Codex CLI 0.154.0 `mcp list --json` discovered the projected shared stdio connections and environment-variable references in an isolated configuration. Pi's real stdio execution and lifecycle regression passed.

Native Codex/Claude bounded business calls still require unavailable model authentication and the missing Claude executable. The isolated Codex probe supplied trust only for its owned fixture workspace; production reconciliation does not grant external-client trust or copy provider OAuth credentials.

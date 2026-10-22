# 06: Use the Pi extension for native stdio MCP connections

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** A user can manage a project-local stdio MCP in the plugin panel, use it from a Pi Bot, and use the same connection when starting Pi directly in the Shared Workspace. Pi uses the existing MCP extension rather than the daemon's duplicate custom transport path. Native edits and effective runtime status remain visible.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

**Spec coverage:** User Stories 46, 61, 62, 63, 64, 77. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Select and exercise a compatible pi-mcp-adapter revision using its documented project discovery, SDK integration, and machine-readable runtime status interfaces. Provision it as a project/product dependency so direct Pi startup can load it without a user-global installation.
- [ ] Support an end-to-end stdio connection with a real local server: configuration through the existing Client/public operations, native startup discovery, tool discovery/call, and a bounded externally verifiable effect. Do not reconstruct an MCP stack or parse the extension's terminal text for status.
- [ ] Recognize native project additions, edits, enablement overrides, and removals in the panel. Preserve the extension's native user/project rules and unrelated configuration, without importing unrelated host-specific settings or rewriting user-level files.
- [ ] Show configured, enabled/disabled, failed, and actually loaded/connected conditions honestly. Extension metadata discovery does not automatically imply a live connection, and one session's status must not misrepresent another Bot's runtime.
- [ ] Apply changes through the supported safe reload/session lifecycle. Do not terminate unrelated Active Turns to refresh configuration. Disabled/removed tools disappear after the applicable reload and old child connections are released without killing unrelated processes.
- [ ] Migrate existing custom stdio definitions, arguments, relevant environment/secret references, and enablement choices without losing meaning. Remove the old runtime route for migrated stdio connections; prove one user tool action is not executed through both routes. Unmigrated remote/official connections belong to later slices, not duplicate routing for the same connection.
- [ ] Do not expose credentials through panel DTOs, management inspection, logs, or shared config. Preserve write-only secret handling or safe credential references; configuration discovery must not require copying secrets into model-visible state.
- [ ] Exercise real Pi plus the selected extension and a deterministic local MCP server, including direct CLI startup, a product Bot call, disable/reload, failure, restart, and targeted teardown. Browser-check the usable panel path; fake workers alone are not compatibility proof.
- [ ] Keep dependencies and test configuration isolated and host-safe. Integrate necessary local prefactoring with this behavior and update the now-changed stdio runtime/configuration documentation.

## Comments

### 2026-09-12 — Real native stdio execution

A real Pi model invoked the pinned `pi-mcp-adapter@2.33.0` gateway against a local SDK stdio server; both the result file (`total=23`) and server call log confirmed business execution.

The real-worker regression covers duplicate adapter registration, a private environment value, pending-reload clearance, command-argument edits retaining private credentials, replacement child identity, and removal releasing idle children without another Check or daemon shutdown. No daemon-injected business MCP implementation is used.

# 07: Connect remote MCPs with real authorization and status

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** A user can configure and use remote MCP connections through the Pi extension, supply supported credentials safely, and complete an interactive authorization flow when required. Both the product and native Pi report observed connection and reload state. External clients may authenticate independently.

**Blocked by:** [06: Use the Pi extension for native stdio MCP connections](06-pi-native-stdio-mcp.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 19, 59, 60, 71. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Extend the working native MCP path to the remote HTTP transport variants supported by the product contract and selected extension. Exercise actual transport behavior rather than accepting a URL and claiming compatibility from a configuration parse.
- [ ] Support the required bearer/header and OAuth setup paths without returning stored secrets in public state, model-visible results, logs, or shared project files. Use the selected runtime's supported credential integration, not a second invented authentication store or automatic cross-client token copy.
- [ ] From the Client, initiate required authorization, expose the user-facing action, complete the callback safely, and allow a real authorized tool call. Cancellation, denial, expiry/revocation, missing consent, and connection failures remain observable and are not reported as success.
- [ ] Preserve native Agent and provider consent behavior; no new general approval layer is introduced. An external native client can perform its own login, and synchronized connection configuration is not advertised as shared OAuth state.
- [ ] Reflect connection, authentication-needed, disabled, pending-reload, and failed conditions in the panel without conflating requested configuration with active runtime state. Refresh through real lifecycle hooks without interrupting unrelated Bot work.
- [ ] Migrate existing custom remote connection meaning and relevant credential references conservatively. Remove the old duplicate runtime route for migrated remote custom connections. Official Service cutover remains separately owned by the Service tickets.
- [ ] Use deterministic local authenticated HTTP/OAuth fixtures for error and callback regressions, and real Pi/extension tool calls for native integration. Verify any advertised legacy transport fallback with its actual scenario; do not silently remove support or label an unexercised path working.
- [ ] Perform a separate applicable live remote authorization/call smoke when credentials and registration are available. Record missing live prerequisites explicitly; fixture success is not live provider proof.
- [ ] Verify Client login/error/status interaction in desktop and narrow layouts, preserve Thread and draft state, and update credential/reload support claims to match the exercised runtime.

## Comments

### 2026-09-12 — Native HTTP and controlled OAuth proof

Real Pi SDK / adapter execution against an SDK Streamable HTTP server produced `sum=46`. A separate controlled OAuth resource moved from `needs-auth` through PKCE-validated authorization and headless callback completion to `connected`; its native tool returned `authorized-sum=107`. Tokens and authorization codes were absent from shared configuration. The same scenario ran from the packaged runtime.

Regression coverage preserves cross-process native Node/Bun refresh-lock exclusion, cancelled-waiter behavior, and publication of `needs-auth` rather than stale `not-connected`. Linux/Bun uses an inherited-descriptor Node helper, not a disabled lock. Live provider consent and unexercised transport variants are not claimed by this controlled HTTP proof.

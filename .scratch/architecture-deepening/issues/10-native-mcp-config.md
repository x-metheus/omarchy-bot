# 10: Shared NativeMcpConfig module

**Type:** task
**Status:** ready-for-agent
**Blocked by:** —

**What to build:** `native-mcp.json` stays a file, but its rules live in one `NativeMcpConfig` module in `packages/agent-contract` (next to `nativeMcpRevision`): path, schema, endpoint identity (`server.url ?? JSON.stringify({command, args})`), `${FIELD}` secret and service-token resolution, and status union. The daemon (`apps/daemon/src/modules/plugins/nativeMcp.ts`) writes through it; the Pi worker (`workers/pi/src/native-mcp.ts:22, 76-108`) reads through it instead of hand-parsing and re-deriving the path from `OMARCHY_BOT_HOME`.

- [ ] Tests at the module interface; `shared-plugins.test.ts` / `native-mcp-runtime.test.ts` stop depending on file layout details where the module covers them.

## Comments

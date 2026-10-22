# 10: Shared NativeMcpConfig module

**Type:** task
**Status:** resolved
**Blocked by:** —

**What to build:** `native-mcp.json` stays a file, but its rules live in one `NativeMcpConfig` module in `packages/agent-contract` (next to `nativeMcpRevision`): path, schema, endpoint identity (`server.url ?? JSON.stringify({command, args})`), `${FIELD}` secret and service-token resolution, and status union. The daemon (`apps/daemon/src/modules/plugins/nativeMcp.ts`) writes through it; the Pi worker (`workers/pi/src/native-mcp.ts:22, 76-108`) reads through it instead of hand-parsing and re-deriving the path from `OMARCHY_BOT_HOME`.

- [x] Tests at the module interface; `shared-plugins.test.ts` / `native-mcp-runtime.test.ts` stop depending on file layout details where the module covers them.

## Comments

## Answer

`native-mcp.json` stays the private file. `packages/agent-contract/src/native-mcp-config.ts` owns its path (`nativeMcpPrivateDir`, `nativeMcpConfigFile`), schema, endpoint identity (non-empty `url`, otherwise `JSON.stringify({command, args})`), `${FIELD}` secret keys, and the runtime status union (`NativeMcpStatus.status`). The daemon writes through `parseNativeMcpMetadata`, `nativeMcpEndpoint`, `nativeMcpSecretKey`, and `nativeMcpSecretPlaceholder`. The Pi worker reads through `readNativeMcpMetadata` and `resolveNativeMcpCredentials`, which skip one malformed secret, entry, or service token and still apply the rest. `native-mcp-runtime.test.ts` builds the private directory with `nativeMcpPrivateDir`. Reviewed and APPROVED at `7a7c03a`.

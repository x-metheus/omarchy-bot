import { expect, test } from "bun:test";
import {
  emptyNativeMcpMetadata,
  isNativeMcpRuntimeStatus,
  NATIVE_MCP_RUNTIME_STATUSES,
  nativeMcpConfigFile,
  nativeMcpEndpoint,
  nativeMcpPrivateDir,
  nativeMcpSecretKey,
  nativeMcpSecretPlaceholder,
  parseNativeMcpMetadata,
  resolveNativeMcpCredentials,
} from "./native-mcp-config.ts";

const stdioEndpoint = '{"command":"node","args":["server.mjs"]}';
const envKey = "OMARCHY_BOT_MCP_CEF20F636B6CD021E113F1B6";
const headerKey = "OMARCHY_BOT_MCP_3872142531618160087DB408";

test("native MCP private file lives under the plugins directory", () => {
  expect(nativeMcpConfigFile("/var/bot/plugins")).toBe("/var/bot/plugins/native-mcp.json");
  expect(nativeMcpPrivateDir({ OMARCHY_BOT_HOME: "/bots/home" }, () => "/unused")).toBe("/bots/home/plugins");
  expect(nativeMcpPrivateDir({}, () => "/home/bot")).toBe("/home/bot/.local/share/omarchy-bot/plugins");
});

test("endpoint identity prefers url, otherwise command and args", () => {
  expect(nativeMcpEndpoint({ url: "https://mcp.example/rpc", command: "ignored", args: ["nope"] })).toBe("https://mcp.example/rpc");
  expect(nativeMcpEndpoint({ command: "node", args: ["server.mjs"] })).toBe(stdioEndpoint);
  expect(nativeMcpEndpoint({ command: "node" })).toBe('{"command":"node","args":[]}');
});

test("secret keys and placeholders are stable", () => {
  expect(nativeMcpSecretKey("docs", stdioEndpoint, "env", "TOKEN")).toBe(envKey);
  expect(nativeMcpSecretKey("docs", "https://mcp.example/rpc", "header", "Authorization")).toBe(headerKey);
  expect(nativeMcpSecretPlaceholder("env", "TOKEN", envKey)).toBe("${TOKEN}");
  expect(nativeMcpSecretPlaceholder("header", "Authorization", headerKey)).toBe(`\${${headerKey}}`);
});

test("metadata schema accepts the private file and fills omitted maps", () => {
  expect(parseNativeMcpMetadata({ version: 1, entries: { docs: { id: "mcp_docs", pi: null, codex: null } } })).toEqual({
    version: 1,
    entries: { docs: { id: "mcp_docs", pi: null, codex: null } },
    secrets: {},
    serviceTokens: {},
    packageRevisions: {},
  });
  expect(emptyNativeMcpMetadata()).toEqual(parseNativeMcpMetadata({ version: 1, entries: {} }));
  expect(() => parseNativeMcpMetadata({ version: 2, entries: {} })).toThrow();
  expect(() => parseNativeMcpMetadata({ version: 1, entries: {}, secrets: { bad: { server: "docs" } } })).toThrow();
});

test("runtime status is the worker union, not connection-projection status", () => {
  expect([...NATIVE_MCP_RUNTIME_STATUSES]).toEqual(["connected", "cached", "failed", "needs-auth", "not-connected", "disabled"]);
  expect(isNativeMcpRuntimeStatus("needs-auth")).toBe(true);
  expect(isNativeMcpRuntimeStatus("conflict")).toBe(false);
  expect(isNativeMcpRuntimeStatus("error")).toBe(false);
});

test("credentials resolve only for the matching endpoint", () => {
  const config: { mcpServers: Record<string, { url?: string; command?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string>; disabled?: boolean }> } = {
    mcpServers: {
      docs: {
        command: "node",
        args: ["server.mjs"],
        env: { TOKEN: "${TOKEN}", PLAIN: "visible", BANG: "${BANG}" },
        headers: { Authorization: `\${${headerKey}}`, Other: "kept" },
      },
      moved: {
        command: "node",
        args: ["other.mjs"],
        env: { TOKEN: "${TOKEN}" },
      },
      owned: { url: "https://mcp.example/rpc", disabled: false },
      headed: { url: "https://mcp.example/rpc", headers: { "X-Api-Key": "${KEEP}" } },
      disabled: { url: "https://mcp.example/rpc", disabled: true },
      retargeted: { url: "https://replacement.example/rpc" },
    },
  };
  const metadata = parseNativeMcpMetadata({
    version: 1,
    entries: {
      docs: { id: "mcp_docs", pi: null, codex: null },
      owned: { id: "mcp_owned", pi: null, codex: null, owner: { accountId: "acct", serviceId: "svc" } },
      headed: { id: "mcp_headed", pi: null, codex: null, owner: { accountId: "acct", serviceId: "svc" } },
      disabled: { id: "mcp_disabled", pi: null, codex: null, owner: { accountId: "acct", serviceId: "svc" } },
      retargeted: { id: "mcp_retargeted", pi: null, codex: null, owner: { accountId: "acct", serviceId: "svc" } },
    },
    secrets: {
      [envKey]: { server: "docs", endpoint: stdioEndpoint, kind: "env", field: "TOKEN", value: "env-secret" },
      bang: { server: "docs", endpoint: stdioEndpoint, kind: "env", field: "BANG", value: "!literal" },
      [headerKey]: { server: "docs", endpoint: stdioEndpoint, kind: "header", field: "Authorization", value: "header-secret" },
      stale: { server: "moved", endpoint: stdioEndpoint, kind: "env", field: "TOKEN", value: "stale-secret" },
    },
    serviceTokens: {
      owned: { url: "https://mcp.example/rpc", token: "svc-token" },
      headed: { url: "https://mcp.example/rpc", token: "nope" },
      disabled: { url: "https://mcp.example/rpc", token: "nope" },
      retargeted: { url: "https://mcp.example/rpc", token: "nope" },
      docs: { url: "https://mcp.example/rpc", token: "unowned" },
    },
  });

  resolveNativeMcpCredentials(config, metadata);

  const docs = config.mcpServers.docs!;
  const moved = config.mcpServers.moved!;
  const owned = config.mcpServers.owned!;
  const headed = config.mcpServers.headed!;
  const disabled = config.mcpServers.disabled!;
  const retargeted = config.mcpServers.retargeted!;
  expect(docs.env).toEqual({ TOKEN: "env-secret", PLAIN: "visible", BANG: "!!literal" });
  expect(docs.headers).toEqual({ Authorization: "header-secret", Other: "kept" });
  expect(moved.env).toEqual({ TOKEN: "${TOKEN}" });
  expect(owned.headers).toEqual({ Authorization: "Bearer svc-token" });
  expect(headed.headers).toEqual({ "X-Api-Key": "${KEEP}" });
  expect(disabled.headers).toBeUndefined();
  expect(retargeted.headers).toBeUndefined();
});

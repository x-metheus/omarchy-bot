import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeMcpConfigFile, nativeMcpEndpoint, nativeMcpSecretKey } from "@omarchy-bot/agent-contract/native-mcp-config";
import { nativeMcpRevision } from "@omarchy-bot/agent-contract/native-mcp-revision";
import { NativeMcpStore } from "./nativeMcp.ts";

test("effectiveServers merges native definitions and resolves private credentials for the runtime", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-")));
  const workspace = path.join(root, "workspace");
  const privateDir = path.join(root, "private");
  const file = nativeMcpConfigFile(privateDir);
  try {
    mkdirSync(path.join(workspace, ".pi"), { recursive: true });
    mkdirSync(path.join(workspace, ".codex"));
    mkdirSync(privateDir);
    const stdio = { command: "fixture", args: ["initial"], env: { SETTING: "${SETTING}", MODE: "type", API_KEY: "k" } };
    writeFileSync(path.join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: {
      local: stdio,
      remote: { url: "https://remote.example/mcp", headers: { "X-Project": "example" } },
      disabled: { command: "disabled-fixture", disabled: true },
      invalid: { command: 42 },
      events: { type: "sse", url: "https://events.example/mcp" },
      socket: { type: "socket", socket: "/tmp/fixture.sock" },
    } }));
    writeFileSync(path.join(workspace, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {
      local: { args: ["override"] },
      piOnly: { command: "pi-fixture" },
    } }));
    writeFileSync(path.join(workspace, ".codex", "config.toml"), '[mcp_servers.codexOnly]\ncommand = "codex-fixture"\n');
    const endpoint = nativeMcpEndpoint({ ...stdio, args: ["override"] });
    const key = nativeMcpSecretKey("local", endpoint, "env", "SETTING");
    writeFileSync(file, JSON.stringify({ version: 1, entries: {}, secrets: {
      [key]: { server: "local", endpoint, kind: "env", field: "SETTING", value: "!fixture-secret" },
    } }));
    const store = new NativeMcpStore(workspace, privateDir);
    const url = "https://account.example/mcp";
    store.putService("account", { url }, { accountId: "account-id", serviceId: "service-id" });
    store.setServiceToken("account", url, "fixture-account-token");

    const { secrets, ...effective } = store.effectiveServers();
    expect([...secrets].sort()).toEqual(["!fixture-secret", "Bearer fixture-account-token", "fixture-account-token", "k"]);
    expect(effective).toEqual({
      revision: nativeMcpRevision(workspace, file),
      servers: {
        local: { disabled: false, transport: { type: "stdio", command: "fixture", args: ["override"], env: { SETTING: "!fixture-secret", MODE: "type", API_KEY: "k" } } },
        remote: { disabled: false, transport: { type: "http", url: "https://remote.example/mcp", headers: { "X-Project": "example" } } },
        disabled: { disabled: true, transport: { type: "stdio", command: "disabled-fixture", args: [] } },
        piOnly: { disabled: false, transport: { type: "stdio", command: "pi-fixture", args: [] } },
        codexOnly: { disabled: false, transport: { type: "stdio", command: "codex-fixture", args: [] } },
        account: { disabled: false, transport: { type: "http", url, headers: { Authorization: "Bearer fixture-account-token" } } },
        events: { disabled: false, transport: { type: "sse" } },
        socket: { disabled: false, transport: { type: "socket" } },
      },
    });
    const panel = store.list(true);
    expect(panel.find(({ name }) => name === "local")?.transport).toEqual({ type: "stdio", command: "fixture", args: ["override"], envKeys: ["SETTING", "MODE", "API_KEY"] });
    expect(panel.find(({ name }) => name === "remote")?.transport).toEqual({ type: "http", url: "https://remote.example/mcp", headerKeys: ["X-Project"] });
    expect(JSON.stringify(panel)).not.toContain("fixture-account-token");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveServers projects the adapter OAuth marker and reconciliation retains it in the shared file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-oauth-marker-"));
  try {
    const url = "https://work.example/mcp";
    const config = path.join(root, ".mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { work: { url, auth: "oauth" } } }));
    const store = new NativeMcpStore(root, path.join(root, "private"));
    store.reconcile();
    expect(store.errors).toEqual([]);
    const snapshot = store.effectiveServers();
    expect(snapshot.configurationError).toBeUndefined();
    expect(snapshot.servers.work).toEqual({ disabled: false, transport: { type: "http", url } });
    expect(JSON.parse(readFileSync(config, "utf8")).mcpServers.work.auth).toBe("oauth");
    expect(Bun.TOML.parse(readFileSync(path.join(root, ".codex", "config.toml"), "utf8")))
      .toMatchObject({ mcp_servers: { work: { url, enabled: true } } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveServers retains service OAuth after reconciliation and drops it when the URL changes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-service-oauth-"));
  try {
    const url = "https://work.example/mcp";
    const redirectUri = "http://localhost:12798/callback";
    const authServerMetadataUrl = "https://login.example/.well-known/openid-configuration";
    const config = path.join(root, ".mcp.json");
    const store = new NativeMcpStore(root, path.join(root, "private"));
    store.putService("work", { url, auth: "oauth", oauth: { clientId: "work-client", redirectUri, authServerMetadataUrl, scope: "work.read" } },
      { accountId: "work-account", serviceId: "work-service" });
    store.reconcile();
    expect(store.errors).toEqual([]);
    expect(JSON.parse(readFileSync(config, "utf8")).mcpServers.work.auth).toBe("oauth");
    expect(store.effectiveServers().servers.work?.transport).toEqual({
      type: "http", url, oauth: { clientId: "work-client", callbackUrl: redirectUri, callbackPort: 12798, authServerMetadataUrl, scope: "work.read" },
    });

    const moved = "https://new.work.example/mcp";
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(path.join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { work: { url: moved } } }));
    store.reconcile();
    expect(store.errors).toEqual([]);
    expect(JSON.parse(readFileSync(config, "utf8")).mcpServers.work).toEqual({ url: moved, disabled: false });
    expect(store.effectiveServers().servers.work?.transport).toEqual({ type: "http", url: moved });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveServers projects only recognized OAuth fields and redacts the client secret", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-oauth-"));
  try {
    const url = "https://work.example/mcp";
    const clientSecret = crypto.randomUUID();
    const oauth = { clientId: "work-client", clientSecret, callbackUrl: "http://127.0.0.1/finish", callbackPort: 12219,
      authServerMetadataUrl: "https://login.example/metadata", scope: "work.read work.write", clientName: "Work Client", clientRegistration: "dcr" };
    const redirectDefaultPort = "http://localhost:80/callback";
    const redirectWithoutPort = "http://localhost/callback";
    writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      handEdited: { url, oauth: { ...oauth, redirectUri: "http://localhost:1111/callback", unknownField: "discard" } },
      defaultPort: { url, oauth: { redirectUri: redirectDefaultPort } },
      ephemeralPort: { url, oauth: { redirectUri: redirectWithoutPort } },
      oauthFalse: { url, oauth: false },
    } }));
    const store = new NativeMcpStore(root, path.join(root, "private"));
    store.reconcile();
    expect(store.errors).toEqual([]);
    const { servers, secrets } = store.effectiveServers();
    expect(Bun.deepEquals(servers.handEdited?.transport, { type: "http", url, oauth })).toBe(true);
    expect(Bun.deepEquals(secrets, [clientSecret])).toBe(true);
    expect(servers.defaultPort?.transport).toEqual({ type: "http", url, oauth: { callbackUrl: redirectDefaultPort, callbackPort: 80 } });
    expect(servers.ephemeralPort?.transport).toEqual({ type: "http", url, oauth: { callbackUrl: redirectWithoutPort } });
    expect(servers.oauthFalse?.transport).toEqual({ type: "http", url });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveServers gives daemon callback settings precedence over the adapter redirect URI", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-oauth-callback-"));
  try {
    const url = "https://work.example/mcp";
    const redirectUri = "http://localhost:1111/callback";
    writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      port: { url, oauth: { redirectUri, callbackPort: 2222 } },
      defaultPort: { url, oauth: { redirectUri, callbackPort: 80 } },
      callback: { url, oauth: { redirectUri, callbackUrl: "http://localhost:3333/x" } },
      callbackWithoutPort: { url, oauth: { redirectUri, callbackUrl: "http://localhost/x" } },
    } }));
    const { servers } = new NativeMcpStore(root, path.join(root, "private")).effectiveServers();
    expect(servers.port?.transport).toEqual({ type: "http", url, oauth: { callbackUrl: "http://localhost:2222/callback", callbackPort: 2222 } });
    expect(servers.defaultPort?.transport).toEqual({ type: "http", url, oauth: { callbackUrl: "http://localhost:80/callback", callbackPort: 80 } });
    expect(servers.callback?.transport).toEqual({ type: "http", url, oauth: { callbackUrl: "http://localhost:3333/x" } });
    expect(servers.callbackWithoutPort?.transport).toEqual({ type: "http", url, oauth: { callbackUrl: "http://localhost/x" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveServers reports invalid OAuth and unsupported credentials per HTTP connection", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-invalid-oauth-"));
  try {
    const url = "https://work.example/mcp";
    const sensitiveValue = crypto.randomUUID();
    const invalid = {
      badClientId: { oauth: { clientId: [sensitiveValue] } },
      emptyClientName: { oauth: { clientName: " " } },
      nonLoopback: { oauth: { redirectUri: `http://${sensitiveValue}.example/callback` } },
      httpsRedirect: { oauth: { callbackUrl: `https://localhost/${sensitiveValue}` } },
      badMetadata: { oauth: { authServerMetadataUrl: `/metadata/${sensitiveValue}` } },
      invalidPort: { oauth: { callbackPort: 65_536 } },
      invalidRegistration: { oauth: { clientRegistration: sensitiveValue } },
      nullOAuth: { oauth: null },
      bareAuth: { auth: sensitiveValue },
      bearerAuth: { auth: "bearer" },
      objectAuth: { auth: { type: "oauth", value: sensitiveValue } },
      disabledAuth: { auth: false },
      bareBearer: { bearerToken: sensitiveValue },
      oauthWithBareBearer: { auth: "oauth", bearerToken: sensitiveValue },
    };
    writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      ...Object.fromEntries(Object.entries(invalid).map(([name, definition]) => [name, { url, ...definition }])),
      valid: { url },
    } }));
    const store = new NativeMcpStore(root, path.join(root, "private"));
    const snapshot = store.effectiveServers();
    expect(JSON.stringify(snapshot).includes(sensitiveValue)).toBe(false);
    expect(snapshot.configurationError).toBeUndefined();
    for (const name of Object.keys(invalid)) {
      const server = snapshot.servers[name];
      expect(server && "configurationError" in server && typeof server.configurationError === "string").toBe(true);
      expect(server?.transport).toBeUndefined();
    }
    expect(snapshot.servers.valid?.transport).toEqual({ type: "http", url });
    store.reconcile();
    expect(store.errors).toContainEqual(expect.stringMatching(/^bearerAuth: .*auth/));
    expect(store.errors).toContainEqual(expect.stringMatching(/^objectAuth: .*auth/));
    expect(JSON.stringify(store.errors).includes(sensitiveValue)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["replaced", "deleted"] as const)("a later save cannot restore a service token after private metadata is %s", (change) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-token-"));
  const privateDir = path.join(root, "private");
  const file = nativeMcpConfigFile(privateDir);
  const url = "https://account.example/mcp";
  const metadata = { version: 1, entries: {
    account: { id: "account", pi: null, codex: null, owner: { accountId: "account-id", serviceId: "service-id" } },
  } };
  try {
    mkdirSync(privateDir);
    writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { account: { url } } }));
    writeFileSync(file, JSON.stringify({ ...metadata, serviceTokens: { account: { url, token: "fixture-removed-token" } } }));
    const store = new NativeMcpStore(root, privateDir);
    const before = store.effectiveServers();
    expect(before.servers.account?.transport).toEqual({ type: "http", url, headers: { Authorization: "Bearer fixture-removed-token" } });
    expect(before.secrets).toContain("fixture-removed-token");

    if (change === "deleted") rmSync(file);
    else writeFileSync(file, JSON.stringify(metadata));
    const after = store.effectiveServers();
    expect(after.revision).not.toBe(before.revision);
    expect(after.servers.account?.transport).toEqual({ type: "http", url });
    expect(after.secrets).toEqual([]);
    expect(after.configurationError).toBeUndefined();

    const saved = store.save(null, { name: "unrelated", enabled: true, transport: { type: "stdio", command: "fixture" } });
    const afterSave = store.effectiveServers();
    expect(afterSave.servers.unrelated).toBeDefined();
    expect(afterSave.servers.account?.transport).toEqual({ type: "http", url });
    expect(afterSave.secrets).toEqual([]);
    expect(afterSave.configurationError).toBeUndefined();
    expect(JSON.stringify([after, saved, afterSave, store.list(true)])).not.toContain("fixture-removed-token");
    expect(readFileSync(file, "utf8")).not.toContain("fixture-removed-token");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveServers collects both the authorization header and the bearer token", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-headers-"));
  try {
    const url = "https://remote.example/mcp";
    writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      remote: { url, headers: { aUtHoRiZaTiOn: "Bearer fixture-bearer" } },
    } }));
    const store = new NativeMcpStore(root, path.join(root, "private"));
    expect(store.effectiveServers().secrets.sort()).toEqual(["Bearer fixture-bearer", "fixture-bearer"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveServers collects individual values from a saved private cookie header", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-cookie-"));
  const session = "fixture-session==";
  const cookie = `session=${session}; theme= fixture-theme ; empty= ; bare`;
  try {
    const store = new NativeMcpStore(root, path.join(root, "private"));
    const url = "https://remote.example/mcp";
    const saved = store.save(null, { name: "remote", enabled: true, transport: { type: "http", url, headers: { cOoKiE: cookie } } });
    const effective = store.effectiveServers();
    expect(effective.secrets.sort()).toEqual([cookie, session, "fixture-theme"].sort());
    expect(effective.servers.remote?.transport).toEqual({ type: "http", url, headers: { cOoKiE: cookie } });
    expect(JSON.stringify([saved, store.list()])).not.toContain(session);
    expect(readFileSync(path.join(root, ".mcp.json"), "utf8")).not.toContain(session);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveServers omits a deleted shared server even while its Codex copy remains", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-deletion-"));
  const privateDir = path.join(root, "private");
  const shared = path.join(root, ".mcp.json");
  const codex = path.join(root, ".codex", "config.toml");
  try {
    const store = new NativeMcpStore(root, privateDir);
    store.save(null, { name: "removed", enabled: true, transport: { type: "stdio", command: "fixture" } });
    expect(store.effectiveServers().servers.removed).toBeDefined();
    expect(Bun.TOML.parse(readFileSync(codex, "utf8"))).toMatchObject({ mcp_servers: { removed: { command: "fixture" } } });

    writeFileSync(shared, '{ "mcpServers": {} }\n');
    const files = [shared, codex, nativeMcpConfigFile(privateDir)];
    const before = files.map((file) => readFileSync(file, "utf8"));
    const effective = store.effectiveServers();
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
    expect(store.list()).toEqual([]);
    expect(effective.configurationError).toBeUndefined();
    expect(effective.servers).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["sig", "signature"])("the store rejects and sanitizes the %s URL credential", (name) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-url-"));
  try {
    const store = new NativeMcpStore(root, path.join(root, "private"));
    const url = `https://remote.example/mcp?${name}=fixture-query-secret`;
    expect(() => store.save(null, { name: "remote", enabled: true, transport: { type: "http", url } }))
      .toThrow(/^Keep MCP credentials out of URLs$/);

    writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url } } }));
    expect(store.effectiveServers().servers.remote).toBeUndefined();
    const panel = store.list();
    expect(panel).toEqual([expect.objectContaining({ readOnly: true, error: expect.stringMatching(/Move URL credentials/) })]);
    expect(JSON.stringify(panel)).not.toContain("fixture-query-secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP snapshots and reconciliation reject a workspace configuration over 1 MiB", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-mcp-oversize-"));
  const store = new NativeMcpStore(root, path.join(root, "private"));
  const file = path.join(root, ".mcp.json");
  try {
    const ordinary = JSON.stringify({ mcpServers: { local: { command: "fixture" } } });
    writeFileSync(file, ordinary);
    expect(store.list()).toEqual([expect.objectContaining({ name: "local", status: "unchecked" })]);
    const oversized = ordinary + " ".repeat(1024 * 1024);
    writeFileSync(file, oversized);
    expect(store.effectiveServers()).toMatchObject({
      servers: {}, configurationError: expect.stringMatching(/\.mcp\.json.*exceeds 1 MiB/),
    });
    expect(store.list()).toEqual([]);
    expect(store.errors).toEqual([expect.stringMatching(/\.mcp\.json.*exceeds 1 MiB/)]);
    expect(JSON.stringify(store.errors)).not.toContain(root);
    expect(readFileSync(file, "utf8")).toBe(oversized);
    writeFileSync(file, ordinary);
    expect(store.list()).toEqual([expect.objectContaining({ name: "local", status: "unchecked" })]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveServers rejects a workspace FIFO without blocking", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-native-mcp-fifo-"));
  const fifo = path.join(root, ".mcp.json");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const child = Bun.spawn([process.execPath, "--eval", `
import { NativeMcpStore } from ${JSON.stringify(new URL("./nativeMcp.ts", import.meta.url).href)};
const store = new NativeMcpStore(${JSON.stringify(root)}, ${JSON.stringify(path.join(root, "private"))});
console.log(JSON.stringify(store.effectiveServers()));
`], { stdout: "pipe", stderr: "inherit" });
    try {
      const [stdout, exitCode] = await Promise.race([
        Promise.all([new Response(child.stdout).text(), child.exited]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("effectiveServers blocked on the workspace FIFO for 1,000 ms")), 1_000);
        }),
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        servers: {}, configurationError: expect.stringMatching(/\.mcp\.json.*regular file/),
      });
      expect(stdout).not.toContain(root);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstalledSkillDto, McpConnectionDto, PluginStateDto, SkillCommandDto } from "../../packages/protocol/src/plugins.ts";
import { api, apiStatus, startDaemon, type Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  globalThis.fetch = originalFetch;
});

async function startPlugins(): Promise<Harness> {
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "plugin-catalog.invalid") return Response.json([]);
    return originalFetch(input, init);
  }, { preconnect: originalFetch.preconnect });
  const h = await startDaemon();
  harness = h;
  const configured = await fetch(`${h.baseUrl}/api/plugins/settings`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cloudUrl: "https://plugin-catalog.invalid" }),
  });
  if (!configured.ok) throw new Error(`Plugin setup failed: ${configured.status}`);
  return h;
}

test("workspace Skill edits are discoverable and removal is not resurrected after restart", async () => {
  const h = await startPlugins();
  const directory = path.join(h.home, ".omarchy-bot", "workspace", ".agents", "skills", "release-check");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), "---\nname: release-check\ndescription: Check release evidence\n---\nRead the release evidence before approving.\n");
  const installed = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect(installed.skills.find((skill) => skill.name === "release-check")).toMatchObject({ enabled: true });
  const commands = await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands");
  expect(commands.some((skill) => skill.command === "/skill:release-check")).toBe(true);

  await writeFile(path.join(directory, "SKILL.md"), "---\nname: release-check\ndescription: Review release notes and checksums\n---\nRead release notes and verify checksums.\n");
  const edited = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect(edited.skills.find((skill) => skill.name === "release-check")?.description).toBe("Review release notes and checksums");
  await rm(directory, { recursive: true });
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.some((skill) => skill.name === "release-check")).toBe(false);
  await h.stop();
  harness = await startDaemon(h.home);
  expect((await api<PluginStateDto>(harness, "GET", "/api/plugins")).skills.some((skill) => skill.name === "release-check")).toBe(false);
});

test("native project MCP additions and removals are reflected in the plugin inventory", async () => {
  const h = await startPlugins();
  const workspace = path.join(h.home, ".omarchy-bot", "workspace");
  await mkdir(workspace, { recursive: true });
  const configuration = path.join(workspace, ".mcp.json");
  await writeFile(configuration, JSON.stringify({ mcpServers: { "local-docs": { command: process.execPath, args: ["--version"] } } }));
  const installed = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect(installed.mcp.find((connection) => connection.name === "local-docs")).toMatchObject({ enabled: true });
  await writeFile(configuration, JSON.stringify({ mcpServers: {} }));
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp.some((connection) => connection.name === "local-docs")).toBe(false);
});

test("imported Skills preserve companion edits and external sources across updates, native discovery and restarts", async () => {
  let h = await startPlugins();
  const workspace = path.join(h.home, ".omarchy-bot", "workspace");
  const source = path.join(h.home, "external-skills", "artifact-review");
  const document = "---\nname: artifact-review\ndescription: Review packaged artifacts\n---\nUse scripts/review.py to inspect the artifact.\n";
  const originalScript = "print('upstream original')\n";
  const editedScript = "print('locally customized artifact review')\n";
  const upstreamScript = "print('upstream replacement')\n";
  await mkdir(path.join(source, "scripts"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), document);
  await writeFile(path.join(source, "scripts", "review.py"), originalScript);

  const installed = await api<InstalledSkillDto>(h, "POST", "/api/plugins/skills", { source });
  expect(installed).toMatchObject({ source, sourceType: "local", origin: "installed", enabled: true });
  if (!installed.path) throw new Error("Imported Skill has no public resource path");
  const installedPath = installed.path;
  expect(await realpath(installedPath)).not.toBe(await realpath(path.join(source, "SKILL.md")));
  expect(await readFile(installedPath, "utf8")).toBe(document);
  const companion = path.join(path.dirname(installedPath), "scripts", "review.py");
  expect(await readFile(companion, "utf8")).toBe(originalScript);
  const nativePaths = [".agents", ".claude"].map((client) => path.join(workspace, client, "skills", installed.name));
  for (const directory of nativePaths) {
    expect(await realpath(path.join(directory, "SKILL.md"))).toBe(await realpath(installedPath));
    expect(await readFile(path.join(directory, "scripts", "review.py"), "utf8")).toBe(originalScript);
  }
  const skillRoute = `/api/plugins/skills/${encodeURIComponent(installed.id)}`;
  const command = `/skill:${installed.name}`;
  expect((await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands")).filter((entry) => entry.command === command)).toHaveLength(1);

  await writeFile(companion, editedScript);
  await writeFile(path.join(source, "scripts", "review.py"), upstreamScript);
  expect((await apiStatus(h, "POST", "/api/plugins/skills", { id: installed.id })).status).toBe(409);
  expect(await readFile(companion, "utf8")).toBe(editedScript);
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.find((skill) => skill.id === installed.id)?.modified).toBe(true);
  expect(await readFile(path.join(source, "scripts", "review.py"), "utf8")).toBe(upstreamScript);

  expect((await apiStatus(h, "PATCH", skillRoute, { enabled: false })).status).toBe(204);
  const disabled = (await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.find((skill) => skill.id === installed.id);
  expect(disabled?.enabled).toBe(false);
  expect((await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands")).some((entry) => entry.command === command)).toBe(false);
  for (const directory of nativePaths) await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(source, "SKILL.md"), "utf8")).toBe(document);
  expect((await apiStatus(h, "PATCH", skillRoute, { enabled: true })).status).toBe(204);
  await api<PluginStateDto>(h, "GET", "/api/plugins");
  for (const directory of nativePaths) expect(await readFile(path.join(directory, "scripts", "review.py"), "utf8")).toBe(editedScript);
  expect((await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands")).some((entry) => entry.command === command)).toBe(true);

  const malformed = "---\nname: [unterminated\n";
  await writeFile(installedPath, malformed);
  const invalid = (await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.find((skill) => skill.id === installed.id);
  expect(invalid?.error).toEqual(expect.any(String));
  expect(invalid?.enabled).toBe(false);
  expect(await readFile(installedPath, "utf8")).toBe(malformed);
  expect((await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands")).some((entry) => entry.command === command)).toBe(false);
  await h.stop();
  h = harness = await startDaemon(h.home);
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.find((skill) => skill.id === installed.id)?.error).toEqual(expect.any(String));
  expect(await readFile(installedPath, "utf8")).toBe(malformed);
  await writeFile(installedPath, document);
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.find((skill) => skill.id === installed.id)?.enabled).toBe(true);
  expect(await readFile(companion, "utf8")).toBe(editedScript);

  expect((await apiStatus(h, "DELETE", skillRoute)).status).toBe(204);
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.some((skill) => skill.id === installed.id)).toBe(false);
  for (const directory of nativePaths) await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  await h.stop();
  h = harness = await startDaemon(h.home);
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.some((skill) => skill.id === installed.id)).toBe(false);
  expect((await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands")).some((entry) => entry.command === command)).toBe(false);
  for (const directory of nativePaths) await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(source, "SKILL.md"), "utf8")).toBe(document);
  expect(await readFile(path.join(source, "scripts", "review.py"), "utf8")).toBe(upstreamScript);
}, 20_000);

test("MCP credentials stay private while native edits preserve client settings and conflicts require source resolution", async () => {
  let h = await startPlugins();
  const workspace = path.join(h.home, ".omarchy-bot", "workspace");
  const sharedPath = path.join(workspace, ".mcp.json");
  const piPath = path.join(workspace, ".pi", "mcp.json");
  const codexPath = path.join(workspace, ".codex", "config.toml");
  const envSecret = "integration-env-secret-never-project-9c6a";
  const headerSecret = "integration-header-secret-never-project-2a8f";
  const stdio = await api<McpConnectionDto>(h, "POST", "/api/plugins/mcp", {
    name: "private-local-docs", enabled: false,
    transport: { type: "stdio", command: process.execPath, args: ["--version"], env: { DOCS_TOKEN: envSecret } },
  });
  const http = await api<McpConnectionDto>(h, "POST", "/api/plugins/mcp", {
    name: "private-http-docs", enabled: false,
    transport: { type: "http", url: "https://mcp.invalid/original", headers: { Authorization: headerSecret } },
  });
  const createdState = await api<PluginStateDto>(h, "GET", "/api/plugins");
  for (const secret of [envSecret, headerSecret]) {
    expect(JSON.stringify([stdio, http, createdState])).not.toContain(secret);
    for (const file of [sharedPath, codexPath]) expect(await readFile(file, "utf8")).not.toContain(secret);
  }
  const shared = JSON.parse(await readFile(sharedPath, "utf8"));
  await mkdir(path.dirname(piPath), { recursive: true });
  await writeFile(piPath, JSON.stringify({ mcpServers: { [http.name]: { ...shared.mcpServers[http.name], timeout: 43123 } } }));
  const unrelatedCodex = 'model = "native-user-model"\n[projects."/tmp/example-project"]\ntrust_level = "untrusted"\n';
  await writeFile(codexPath, `${unrelatedCodex}\n${await readFile(codexPath, "utf8")}`);
  await api<PluginStateDto>(h, "GET", "/api/plugins");

  const piEdit = JSON.parse(await readFile(piPath, "utf8"));
  piEdit.mcpServers[http.name].url = "https://mcp.invalid/pi-edit";
  await writeFile(piPath, JSON.stringify(piEdit));
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp.find((entry) => entry.id === http.id)?.transport).toMatchObject({ url: "https://mcp.invalid/pi-edit" });
  expect(Bun.TOML.parse(await readFile(codexPath, "utf8"))).toMatchObject({
    model: "native-user-model", projects: { "/tmp/example-project": { trust_level: "untrusted" } },
    mcp_servers: { [http.name]: { url: "https://mcp.invalid/pi-edit" } },
  });

  await writeFile(codexPath, (await readFile(codexPath, "utf8")).replace("https://mcp.invalid/pi-edit", "https://mcp.invalid/codex-edit"));
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp.find((entry) => entry.id === http.id)?.transport).toMatchObject({ url: "https://mcp.invalid/codex-edit" });
  expect(JSON.parse(await readFile(piPath, "utf8")).mcpServers[http.name]).toMatchObject({ url: "https://mcp.invalid/codex-edit", timeout: 43123 });
  expect(JSON.parse(await readFile(sharedPath, "utf8")).mcpServers[http.name].url).toBe("https://mcp.invalid/codex-edit");

  const conflictingPi = JSON.parse(await readFile(piPath, "utf8"));
  conflictingPi.mcpServers[http.name].url = "https://mcp.invalid/pi-conflict";
  const piConflictText = JSON.stringify(conflictingPi);
  const codexConflictText = (await readFile(codexPath, "utf8")).replace("https://mcp.invalid/codex-edit", "https://mcp.invalid/codex-conflict");
  const sharedBeforeConflict = await readFile(sharedPath, "utf8");
  await writeFile(piPath, piConflictText);
  await writeFile(codexPath, codexConflictText);
  const conflicted = (await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp.find((entry) => entry.id === http.id);
  expect(conflicted?.status).toBe("conflict");
  expect(conflicted?.error).toEqual(expect.any(String));
  expect(await readFile(piPath, "utf8")).toBe(piConflictText);
  expect(await readFile(codexPath, "utf8")).toBe(codexConflictText);
  expect(await readFile(sharedPath, "utf8")).toBe(sharedBeforeConflict);
  await h.stop();
  h = harness = await startDaemon(h.home);
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp.find((entry) => entry.id === http.id)?.status).toBe("conflict");
  expect(await readFile(piPath, "utf8")).toBe(piConflictText);
  expect(await readFile(codexPath, "utf8")).toBe(codexConflictText);

  // The user selects Pi's endpoint by making both native sources agree.
  await writeFile(codexPath, codexConflictText.replace("https://mcp.invalid/codex-conflict", "https://mcp.invalid/pi-conflict"));
  const resolved = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect(resolved.mcp.find((entry) => entry.id === http.id)).toMatchObject({ status: "disabled", transport: { url: "https://mcp.invalid/pi-conflict" } });
  expect(JSON.parse(await readFile(sharedPath, "utf8")).mcpServers[http.name].url).toBe("https://mcp.invalid/pi-conflict");
  expect(JSON.parse(await readFile(piPath, "utf8")).mcpServers[http.name].timeout).toBe(43123);
  expect(Bun.TOML.parse(await readFile(codexPath, "utf8"))).toMatchObject({
    model: "native-user-model", projects: { "/tmp/example-project": { trust_level: "untrusted" } },
  });
  for (const secret of [envSecret, headerSecret]) {
    expect(JSON.stringify(resolved)).not.toContain(secret);
    for (const file of [sharedPath, piPath, codexPath]) expect(await readFile(file, "utf8")).not.toContain(secret);
  }

  // Delete the Pi/Claude definition and its overlay; Codex must not resurrect it.
  const withoutHttp = JSON.parse(await readFile(sharedPath, "utf8"));
  delete withoutHttp.mcpServers[http.name];
  await writeFile(sharedPath, JSON.stringify(withoutHttp));
  const withoutPiHttp = JSON.parse(await readFile(piPath, "utf8"));
  delete withoutPiHttp.mcpServers[http.name];
  await writeFile(piPath, JSON.stringify(withoutPiHttp));
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp.some((entry) => entry.id === http.id)).toBe(false);
  expect((await apiStatus(h, "DELETE", `/api/plugins/mcp/${encodeURIComponent(stdio.id)}`)).status).toBe(204);
  await h.stop();
  h = harness = await startDaemon(h.home);
  const afterRestart = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect(afterRestart.mcp.some((entry) => entry.id === http.id || entry.id === stdio.id)).toBe(false);
  for (const name of [http.name, stdio.name]) {
    expect(JSON.parse(await readFile(sharedPath, "utf8")).mcpServers[name]).toBeUndefined();
    expect(JSON.parse(await readFile(piPath, "utf8")).mcpServers[name]).toBeUndefined();
    expect(Bun.TOML.parse(await readFile(codexPath, "utf8"))).not.toMatchObject({ mcp_servers: { [name]: expect.anything() } });
  }
  expect(Bun.TOML.parse(await readFile(codexPath, "utf8"))).toMatchObject({
    model: "native-user-model", projects: { "/tmp/example-project": { trust_level: "untrusted" } },
  });
}, 20_000);

test("native endpoint overrides do not inherit credentials from the replaced endpoint", async () => {
  const h = await startPlugins();
  const workspace = path.join(h.home, ".omarchy-bot", "workspace");
  const shared = path.join(workspace, ".mcp.json");
  const overlay = path.join(workspace, ".pi", "mcp.json");
  await writeFile(shared, JSON.stringify({ mcpServers: { protected: { url: "https://original.invalid/mcp", headers: { Authorization: "Bearer ${SERVICE_TOKEN}" } } } }));
  await api<PluginStateDto>(h, "GET", "/api/plugins");
  await writeFile(overlay, JSON.stringify({ mcpServers: { protected: { url: "https://replacement.invalid/mcp" } } }));
  const state = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect(state.mcp.find((entry) => entry.name === "protected")?.transport).toEqual({ type: "http", url: "https://replacement.invalid/mcp", headerKeys: [] });
  expect(await readFile(shared, "utf8")).not.toContain("SERVICE_TOKEN");
  expect(await readFile(path.join(workspace, ".codex", "config.toml"), "utf8")).not.toContain("SERVICE_TOKEN");
});

test("malformed and secret-bearing native entries remain untouched with safe visible diagnostics", async () => {
  const h = await startPlugins();
  const file = path.join(h.home, ".omarchy-bot", "workspace", ".mcp.json");
  const text = JSON.stringify({ mcpServers: {
    malformed: { command: "example", args: ["--port", 1234] },
    credential: { url: "https://example.invalid/mcp?api_key=NATIVE_URL_PRIVATE_SENTINEL" },
    socket: { socket: "/tmp/example-mcp.sock" },
  } });
  await writeFile(file, text);
  const state = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect(await readFile(file, "utf8")).toBe(text);
  expect(state.nativeError).toContain("malformed");
  expect(state.nativeError).toContain("socket");
  expect(JSON.stringify(state)).not.toContain("NATIVE_URL_PRIVATE_SENTINEL");
});

test("deleting a Pi-originated MCP removes its generated representations across restart", async () => {
  let h = await startPlugins();
  const workspace = path.join(h.home, ".omarchy-bot", "workspace");
  const overlay = path.join(workspace, ".pi", "mcp.json");
  await writeFile(overlay, JSON.stringify({ mcpServers: { "pi-origin": { command: process.execPath, args: ["--version"] } } }));
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp.some((entry) => entry.name === "pi-origin")).toBe(true);
  await writeFile(overlay, JSON.stringify({ mcpServers: {} }));
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp.some((entry) => entry.name === "pi-origin")).toBe(false);
  await h.stop();
  h = harness = await startDaemon(h.home);
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp.some((entry) => entry.name === "pi-origin")).toBe(false);
  expect(await readFile(path.join(workspace, ".mcp.json"), "utf8")).not.toContain("pi-origin");
  expect(await readFile(path.join(workspace, ".codex", "config.toml"), "utf8")).not.toContain("pi-origin");
});

test("ordinary Creator Python cache files do not masquerade as local source modifications", async () => {
  const h = await startPlugins();
  const creator = (await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.find((skill) => skill.origin === "default")!;
  const cache = path.join(path.dirname(creator.path!), "scripts", "__pycache__");
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, "generate_openai_yaml.cpython-313.pyc"), "runtime-generated bytecode");
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.find((skill) => skill.id === creator.id)?.modified).toBe(false);
  await writeFile(path.join(path.dirname(creator.path!), "scripts", "local-customization.py"), "print('intentional edit')\n");
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.find((skill) => skill.id === creator.id)?.modified).toBe(true);
});

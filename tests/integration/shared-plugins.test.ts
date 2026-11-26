import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeSkills } from "../../apps/daemon/src/modules/plugins/nativeSkills.ts";
import type { InstalledSkillDto, McpConnectionDto, PluginStateDto, SkillCommandDto } from "../../packages/protocol/src/plugins.ts";
import { api, authedFetch, apiStatus, startDaemon, type Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  globalThis.fetch = originalFetch;
});

async function startPlugins(providers: () => Response | Promise<Response> = () => Response.json([])): Promise<Harness> {
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "plugin-catalog.invalid") return url.pathname === "/api/plugins/providers" ? providers() : Response.json([]);
    return originalFetch(input, init);
  }, { preconnect: originalFetch.preconnect });
  const h = await startDaemon();
  harness = h;
  const configured = await authedFetch(h, `${h.baseUrl}/api/plugins/settings`, {
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

test("a six-level workspace Skill appears once in Services and slash commands", async () => {
  const h = await startPlugins();
  const root = path.join(h.svc.cfg.sharedWorkspaceDir, ".agents", "skills");
  const directory = path.join(root, "a", "b", "c", "d", "e", "f");
  const name = "nested-skill";
  const description = "Discover a deeply nested workspace Skill";
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);

  const deep = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect([...deep.skills, ...deep.nativeSkills].filter((skill) => skill.name === name)).toEqual([
    { name, description, path: path.join(directory, "SKILL.md"), readOnly: true },
  ]);
  const command: SkillCommandDto = { name, description, command: `/skill:${name}`, source: "native" };
  expect((await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands")).filter((skill) => skill.name === name)).toEqual([command]);

  const managedDirectory = path.join(root, name);
  await rename(directory, managedDirectory);
  const managed = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect([...managed.skills, ...managed.nativeSkills].filter((skill) => skill.name === name)).toEqual([
    expect.objectContaining({ name, description, path: path.join(managedDirectory, "SKILL.md"), enabled: true, readOnly: false }),
  ]);
  expect((await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands")).filter((skill) => skill.name === name)).toEqual([command]);
});

test("NativeSkills ignores legacy Skills roots and leaves their live and dangling aliases in place", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-skills-"));
  try {
    const workspace = path.join(root, "workspace");
    const privateDir = path.join(root, "plugins");
    for (const [folder, name] of [[".agents", "current-skill"], [".pi", "pi-skill"], [".claude", "claude-skill"]] as const) {
      const directory = path.join(workspace, folder, "skills", name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture skill\n---\n`);
    }
    const nativeRoot = path.join(workspace, ".agents", "skills");
    const aliases = {
      [path.join(workspace, ".claude", "skills", "retired-alias")]: path.join(nativeRoot, "retired-alias"),
      [path.join(nativeRoot, "pi-skill")]: path.join(workspace, ".pi", "skills", "pi-skill"),
      [path.join(nativeRoot, "claude-category")]: path.join(workspace, ".claude", "skills"),
      [path.join(nativeRoot, "dangling-skill")]: path.join(workspace, ".pi", "skills", "missing"),
    };
    for (const [alias, target] of Object.entries(aliases)) await symlink(path.relative(path.dirname(alias), target), alias, "dir");
    await mkdir(privateDir);
    await writeFile(path.join(privateDir, "native-skills.json"), JSON.stringify({ version: 1, entries: [], aliases }));

    const skills = new NativeSkills(workspace, privateDir);
    expect(skills.list().map((skill) => skill.name)).toEqual(["current-skill"]);
    for (const [alias, target] of Object.entries(aliases)) expect(await readlink(alias)).toBe(path.relative(path.dirname(alias), target));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([".pi", ".claude"])("NativeSkills reconciles disabled %s Skill destinations", async (legacyFolder) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-skills-"));
  try {
    const workspace = path.join(root, "workspace");
    const privateDir = path.join(root, "plugins");
    const name = "legacy-skill";
    const nativeRoot = path.join(workspace, ".agents", "skills");
    await mkdir(workspace);
    const legacyDirectory = path.join(workspace, legacyFolder, "skills", name);
    const directory = path.join(privateDir, "disabled-skills", "stored-bundle");
    await mkdir(directory, { recursive: true });
    const document = `---\nname: ${name}\ndescription: Disabled legacy Skill\n---\nPrivate bundle\n`;
    await writeFile(path.join(directory, "SKILL.md"), document);
    await writeFile(path.join(directory, "notes.txt"), "private companion content\n");
    const source = legacyFolder === ".pi"
      ? { origin: "local", sourceType: "local", source: legacyDirectory, installUrl: legacyDirectory }
      : { origin: "installed", sourceType: "github", source: "example/legacy-skill", installUrl: "https://example.invalid/legacy-skill" };
    const entry = {
      ...source, id: "legacy-disabled-id", name, description: "Disabled legacy Skill", revision: "legacy-revision",
      installedAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z",
      directory, activeDirectory: legacyDirectory, baseline: "legacy-baseline", enabled: false,
      baselineVerified: true, error: "Previous update failed", availableRevision: "next-revision",
    };
    const registryFile = path.join(privateDir, "native-skills.json");
    await writeFile(registryFile, JSON.stringify({ version: 1, entries: [entry], defaultsInitialized: true, aliases: {} }));
    const occupied = path.join(nativeRoot, name);
    const dangling = path.join(nativeRoot, `${name}-2`);
    const hasCollisions = legacyFolder === ".claude";
    if (hasCollisions) {
      await mkdir(occupied, { recursive: true });
      await writeFile(path.join(occupied, "notes.txt"), "existing native content\n");
      await symlink(legacyDirectory, dangling, "dir");
    }
    const destination = path.join(nativeRoot, hasCollisions ? `${name}-3` : name);

    const skills = new NativeSkills(workspace, privateDir);
    expect(skills.list()).toEqual([expect.objectContaining({ id: entry.id, enabled: false, error: entry.error, path: path.join(directory, "SKILL.md") })]);
    expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe("private companion content\n");
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const expectedEntry = { ...entry, activeDirectory: destination,
      ...(source.origin === "local" ? { source: destination, installUrl: destination } : {}),
    };
    expect(JSON.parse(await readFile(registryFile, "utf8"))).toMatchObject({ entries: [expectedEntry], defaultsInitialized: true });

    if (hasCollisions) {
      skills.remove(entry.id);
      expect(skills.list()).toEqual([]);
      await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(occupied, "notes.txt"), "utf8")).toBe("existing native content\n");
      expect(await readlink(dangling)).toBe(legacyDirectory);
    } else {
      await mkdir(nativeRoot, { recursive: true });
      await symlink(legacyDirectory, destination, "dir");
      expect(() => skills.enable(entry.id, true)).toThrow("Another Skill occupies the destination");
      expect(await readlink(destination)).toBe(legacyDirectory);
      expect(await readFile(path.join(directory, "SKILL.md"), "utf8")).toBe(document);
      await rm(destination);

      skills.enable(entry.id, true);
      expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe(document);
      expect(await readFile(path.join(destination, "notes.txt"), "utf8")).toBe("private companion content\n");
      expect(skills.list()).toEqual([expect.objectContaining({ id: entry.id, enabled: true, error: entry.error, path: path.join(destination, "SKILL.md") })]);
    }
    expect(await readFile(registryFile, "utf8")).not.toContain(legacyDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  const nativeDirectory = path.join(workspace, ".agents", "skills", installed.name);
  expect(await realpath(path.join(nativeDirectory, "SKILL.md"))).toBe(await realpath(installedPath));
  expect(await readFile(path.join(nativeDirectory, "scripts", "review.py"), "utf8")).toBe(originalScript);
  for (const retired of [".pi", ".codex", ".claude"]) await expect(lstat(path.join(workspace, retired))).rejects.toMatchObject({ code: "ENOENT" });
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
  await expect(lstat(nativeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(source, "SKILL.md"), "utf8")).toBe(document);
  expect((await apiStatus(h, "PATCH", skillRoute, { enabled: true })).status).toBe(204);
  await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect(await readFile(path.join(nativeDirectory, "scripts", "review.py"), "utf8")).toBe(editedScript);
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
  await expect(lstat(nativeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await h.stop();
  h = harness = await startDaemon(h.home);
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.some((skill) => skill.id === installed.id)).toBe(false);
  expect((await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands")).some((entry) => entry.command === command)).toBe(false);
  await expect(lstat(nativeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  for (const retired of [".pi", ".codex", ".claude"]) await expect(lstat(path.join(workspace, retired))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(source, "SKILL.md"), "utf8")).toBe(document);
  expect(await readFile(path.join(source, "scripts", "review.py"), "utf8")).toBe(upstreamScript);
}, 20_000);

test("Services saves preserve shared MCP settings and leave retired configs untouched", async () => {
  let h = await startPlugins();
  const workspace = path.join(h.home, ".omarchy-bot", "workspace");
  const sharedPath = path.join(workspace, ".mcp.json");
  const piPath = path.join(workspace, ".pi", "mcp.json");
  const settingsPath = path.join(workspace, ".pi", "settings.json");
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
  for (const file of [piPath, settingsPath, codexPath]) await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(sharedPath)).mode & 0o777).toBe(0o600);
  const privatePath = path.join(h.svc.cfg.dataDir, "plugins", "native-mcp.json");
  expect((await lstat(privatePath)).mode & 0o777).toBe(0o600);
  const shared = JSON.parse(await readFile(sharedPath, "utf8"));
  expect(shared.mcpServers[stdio.name]).toEqual({ command: process.execPath, args: ["--version"], env: { DOCS_TOKEN: "${DOCS_TOKEN}" }, disabled: true });
  expect(shared.mcpServers[http.name]).toEqual({ url: "https://mcp.invalid/original", headers: { Authorization: expect.stringMatching(/^\$\{OMARCHY_BOT_MCP_[A-F0-9]{24}\}$/) }, disabled: true });
  const metadata = JSON.parse(await readFile(privatePath, "utf8"));
  expect(Object.values(metadata.secrets)).toEqual(expect.arrayContaining([
    expect.objectContaining({ server: stdio.name, field: "DOCS_TOKEN", value: envSecret }),
    expect.objectContaining({ server: http.name, field: "Authorization", value: headerSecret }),
  ]));
  for (const secret of [envSecret, headerSecret]) expect(JSON.stringify([stdio, http, createdState, shared])).not.toContain(secret);

  await mkdir(path.dirname(piPath), { recursive: true });
  await mkdir(path.dirname(codexPath), { recursive: true });
  const retiredFiles = [
    [piPath, JSON.stringify({ mcpServers: { [http.name]: { url: "https://mcp.invalid/pi-edit", timeout: 43123 } } })],
    [settingsPath, '{ "packages": [], "theme": "native-user-theme" }\n'],
    [codexPath, `model = "native-user-model"\n[mcp_servers.${JSON.stringify(http.name)}]\nurl = "https://mcp.invalid/codex-edit"\n`],
  ] as const;
  for (const [file, text] of retiredFiles) await writeFile(file, text, { mode: 0o640 });
  const assertRetiredFilesUnchanged = async () => {
    for (const [file, text] of retiredFiles) {
      expect(await readFile(file, "utf8")).toBe(text);
      expect((await lstat(file)).mode & 0o777).toBe(0o640);
    }
  };

  shared.unrelated = { keep: "native-user-setting" };
  shared.mcpServers[http.name].timeout = 43123;
  await writeFile(sharedPath, JSON.stringify(shared));
  await chmod(sharedPath, 0o640);
  const editedName = "renamed-http-docs";
  const editedUrl = "https://mcp.invalid/shared-edit";
  const editedState = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect(editedState.mcp.find((entry) => entry.id === http.id)).toMatchObject({ source: ".mcp.json", transport: { url: "https://mcp.invalid/original" } });
  const edited = await api<McpConnectionDto>(h, "PUT", `/api/plugins/mcp/${encodeURIComponent(http.id)}`, {
    name: editedName, enabled: true, transport: { type: "http", url: editedUrl },
  });
  expect(edited).toMatchObject({ id: http.id, name: editedName, enabled: true, source: ".mcp.json", transport: { url: editedUrl, headerKeys: [] } });
  expect((await apiStatus(h, "PATCH", `/api/plugins/mcp/${encodeURIComponent(http.id)}`, { enabled: false })).status).toBe(204);
  const expectedShared = { unrelated: shared.unrelated, mcpServers: {
    [stdio.name]: shared.mcpServers[stdio.name], [editedName]: { timeout: 43123, url: editedUrl, disabled: true },
  } };
  const sharedBytes = await readFile(sharedPath, "utf8");
  const privateBytes = await readFile(privatePath, "utf8");
  expect(JSON.parse(sharedBytes)).toEqual(expectedShared);
  expect((await lstat(sharedPath)).mode & 0o777).toBe(0o640);
  await assertRetiredFilesUnchanged();

  await h.stop();
  h = harness = await startDaemon(h.home);
  const afterRestart = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect(afterRestart.mcp.find((entry) => entry.id === http.id)).toMatchObject({ name: editedName, status: "disabled", transport: { url: editedUrl, headerKeys: [] } });
  expect(await readFile(sharedPath, "utf8")).toBe(sharedBytes);
  expect(await readFile(privatePath, "utf8")).toBe(privateBytes);
  expect((await lstat(sharedPath)).mode & 0o777).toBe(0o640);
  expect((await lstat(privatePath)).mode & 0o777).toBe(0o600);
  await assertRetiredFilesUnchanged();
  for (const secret of [envSecret, headerSecret]) expect(JSON.stringify([afterRestart, sharedBytes])).not.toContain(secret);

  await writeFile(sharedPath, JSON.stringify({ ...expectedShared, mcpServers: { [stdio.name]: shared.mcpServers[stdio.name] } }));
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp.some((entry) => entry.id === http.id)).toBe(false);
  expect((await apiStatus(h, "DELETE", `/api/plugins/mcp/${encodeURIComponent(stdio.id)}`)).status).toBe(204);
  await h.stop();
  h = harness = await startDaemon(h.home);
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp).toEqual([]);
  expect(JSON.parse(await readFile(sharedPath, "utf8"))).toEqual({ unrelated: expectedShared.unrelated, mcpServers: {} });
  await assertRetiredFilesUnchanged();
}, 20_000);

test("editing a shared MCP endpoint does not carry its credentials to the new endpoint", async () => {
  const h = await startPlugins();
  const workspace = path.join(h.home, ".omarchy-bot", "workspace");
  const shared = path.join(workspace, ".mcp.json");
  await writeFile(shared, JSON.stringify({ mcpServers: { protected: { url: "https://original.invalid/mcp", headers: { Authorization: "Bearer ${SERVICE_TOKEN}" } } } }));
  const state = await api<PluginStateDto>(h, "GET", "/api/plugins");
  const original = state.mcp.find((entry) => entry.name === "protected")!;
  expect(original.transport).toEqual({ type: "http", url: "https://original.invalid/mcp", headerKeys: ["Authorization"] });
  const edited = await api<McpConnectionDto>(h, "PUT", `/api/plugins/mcp/${encodeURIComponent(original.id)}`, {
    name: original.name, enabled: true, transport: { type: "http", url: "https://replacement.invalid/mcp" },
  });
  expect(edited.transport).toEqual({ type: "http", url: "https://replacement.invalid/mcp", headerKeys: [] });
  expect(await readFile(shared, "utf8")).not.toContain("SERVICE_TOKEN");
  await expect(lstat(path.join(workspace, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
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

test("a Pi-only MCP definition is never copied or discovered across a restart", async () => {
  let h = await startPlugins();
  const workspace = path.join(h.home, ".omarchy-bot", "workspace");
  const overlay = path.join(workspace, ".pi", "mcp.json");
  const contents = JSON.stringify({ mcpServers: { "pi-origin": { command: process.execPath, args: ["--version"] } } });
  await mkdir(path.dirname(overlay), { recursive: true });
  await writeFile(overlay, contents);
  for (let boot = 0; boot < 2; boot++) {
    expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp).toEqual([]);
    await expect(lstat(path.join(workspace, ".mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(workspace, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(overlay, "utf8")).toBe(contents);
    if (boot === 0) {
      await h.stop();
      h = harness = await startDaemon(h.home);
    }
  }
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

test("disabling a skill reads enabled from the request body", async () => {
  const h = await startPlugins();
  const directory = path.join(h.home, ".omarchy-bot", "workspace", ".agents", "skills", "toggle-check");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), "---\nname: toggle-check\ndescription: Toggle me\n---\nStay disabled after the patch.\n");
  const before = await api<PluginStateDto>(h, "GET", "/api/plugins");
  const skill = before.skills.find((entry) => entry.name === "toggle-check");
  if (!skill) throw new Error("toggle-check was not discovered");
  expect((await apiStatus(h, "PATCH", `/api/plugins/skills/${encodeURIComponent(skill.id)}`, { enabled: false })).status).toBe(204);
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).skills.find((entry) => entry.id === skill.id)?.enabled).toBe(false);
});

test("Services refresh lists a Skill disabled during catalog loading exactly once", async () => {
  const requested = Promise.withResolvers<void>();
  const providerResponse = Promise.withResolvers<Response>();
  const h = await startPlugins(() => {
    requested.resolve();
    return providerResponse.promise;
  });
  const name = "disable-during-refresh";
  const source = path.join(h.home, name);
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), `---\nname: ${name}\ndescription: Disable while Services refreshes\n---\n`);
  const installed = await api<InstalledSkillDto>(h, "POST", "/api/plugins/skills", { source });
  expect(installed).toMatchObject({ name, enabled: true, path: expect.any(String) });

  const refresh = api<PluginStateDto>(h, "GET", "/api/plugins");
  await requested.promise;
  let disabled: Awaited<ReturnType<typeof apiStatus>>;
  try {
    disabled = await apiStatus(h, "PATCH", `/api/plugins/skills/${encodeURIComponent(installed.id)}`, { enabled: false });
  } finally {
    providerResponse.resolve(Response.json([]));
  }
  const refreshed = await refresh;
  expect(disabled.status).toBe(204);
  const matches = [...refreshed.skills, ...refreshed.nativeSkills].filter((skill) => skill.name === name);
  expect(matches).toEqual([expect.objectContaining({ id: installed.id, enabled: false, path: expect.stringMatching(/\/disabled-skills\/[^/]+\/SKILL\.md$/) })]);

  const plugins = h.svc.plugins;
  plugins.enableSkill(installed.id, true);
  const commandsBeforeDisable = plugins.commands();
  plugins.enableSkill(installed.id, false);
  const commandsAfterDisable = plugins.commands();
  const [, commands] = await Promise.all([commandsBeforeDisable, commandsAfterDisable]);
  expect(commands.filter((skill) => skill.command === `/skill:${name}`)).toEqual([]);
});

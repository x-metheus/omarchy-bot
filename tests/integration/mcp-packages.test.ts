import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginsService } from "../../apps/daemon/src/modules/plugins/plugins.ts";
import type { McpConnectionDto } from "../../packages/protocol/src/plugins.ts";
import { WorkerClient } from "../../apps/daemon/src/supervision/workerClient.ts";
import type { NativeMcpControlResult } from "../../packages/agent-contract/src/index.ts";
import { apiStatus, startDaemon, type Harness } from "./helpers/harness.ts";

const daemon = path.resolve(import.meta.dir, "../../apps/daemon");
const { Client } = await import(Bun.resolveSync("@modelcontextprotocol/sdk/client/index.js", daemon));
const { StdioClientTransport } = await import(Bun.resolveSync("@modelcontextprotocol/sdk/client/stdio.js", daemon));
const { c: createTar } = await import(Bun.resolveSync("tar", daemon));

test("managed npm updates preserve live native processes, local edits and failed versions without retaining unused history", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "managed-mcp-package-"));
  const workspace = path.join(home, ".omarchy-bot", "workspace");
  const packageName = "omarchy-private-package-fixture";
  const otherPackage = "omarchy-other-package-fixture";
  const token = crypto.randomUUID();
  const canary = path.join(home, "install-script-ran");
  const startup = path.join(home, "native-package-startup.json");
  const artifacts = new Map<string, Buffer>();
  const originalFetch = globalThis.fetch;
  let latest = "1.0.0";
  let corrupt = false;
  let onArtifact: (() => Promise<void>) | undefined;
  let service: PluginsService | undefined;
  let harness: Harness | undefined;
  const clients: Array<InstanceType<typeof Client>> = [];
  const worker = new WorkerClient({ name: "managed-package-binary", script: path.resolve(daemon, "../../workers/pi/src/worker.ts"),
    env: { HOME: home, OMARCHY_BOT_HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin",
      XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share") }, onEvent: () => {} });
  try {
    await mkdir(workspace, { recursive: true });
    for (let version = 1; version <= 7; version++) {
      const directory = path.join(home, `fixture-${version}`);
      const source = path.join(directory, "package");
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "package.json"), JSON.stringify({ name: version === 7 ? otherPackage : packageName, version: `${version}.0.0`, type: "module",
        bin: version === 7 ? { [otherPackage]: "server.mjs", alternate: "alternate.mjs" } : { fixture: "server.mjs" },
        ...(version === 5 ? { scripts: { postinstall: `node -e "require('node:fs').writeFileSync('${canary}', 'ran')"` } } : {}) }));
      await writeFile(path.join(source, "value.txt"), String(version));
      if (version === 7) await writeFile(path.join(source, "alternate.mjs"), "process.argv.push('alternate'); await import('./server.mjs');\n");
      await writeFile(path.join(source, "server.mjs"), `
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { McpServer } from ${JSON.stringify(Bun.resolveSync("@modelcontextprotocol/sdk/server/mcp.js", daemon))};
import { StdioServerTransport } from ${JSON.stringify(Bun.resolveSync("@modelcontextprotocol/sdk/server/stdio.js", daemon))};
if (!process.env.MANAGED_TOKEN) throw new Error('Fixture authentication required');
writeFileSync(${JSON.stringify(startup)}, JSON.stringify({args:process.argv.slice(2),auth:createHash('sha256').update(process.env.MANAGED_TOKEN).digest('hex')}));
const server = new McpServer({name:'managed-fixture',version:${JSON.stringify(`${version}.0.0`)}});
server.registerTool('read', {inputSchema:{}}, async () => ({content:[{type:'text',text:JSON.stringify({value:readFileSync(new URL('./value.txt',import.meta.url),'utf8'),auth:createHash('sha256').update(process.env.MANAGED_TOKEN).digest('hex'),args:process.argv.slice(2)})}]}));
await server.connect(new StdioServerTransport());
`);
      const tarball = path.join(directory, "package.tgz");
      await createTar({ cwd: directory, gzip: true, file: tarball }, ["package"]);
      artifacts.set(`${version}.0.0`, await readFile(tarball));
    }
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === "https://managed-package-catalog.invalid") return Response.json([]);
      const selectedPackage = latest === "7.0.0" ? otherPackage : packageName;
      if (url.origin === "https://registry.npmjs.org" && url.pathname === `/${selectedPackage}/latest`) return Response.json({ name: selectedPackage, version: latest,
        dist: { tarball: `https://registry.npmjs.org/${selectedPackage}/-/fixture-${latest}.tgz`, integrity: `sha512-${createHash("sha512").update(artifacts.get(latest)!).digest("base64")}` } });
      if (url.origin === "https://registry.npmjs.org" && url.pathname.startsWith(`/${selectedPackage}/-/`)) {
        const selected = latest;
        await onArtifact?.();
        const bytes = corrupt ? Buffer.from("corrupted package") : artifacts.get(selected)!;
        if (!(bytes.buffer instanceof ArrayBuffer)) throw new Error("Fixture response requires a non-shared byte buffer");
        return new Response(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      }
      return originalFetch(input, init);
    }, { preconnect: originalFetch.preconnect });
    harness = await startDaemon(home);
    service = harness.svc.plugins;
    service.configure("https://managed-package-catalog.invalid");
    const lease = await service.acquire();
    const installed = await lease.call("manage_plugins", { action: "save_mcp", connection: { name: "managed", package: { name: packageName, env: { MANAGED_TOKEN: token } } } }, new AbortController().signal);
    const installedText = installed.content.find((entry) => entry.type === "text");
    if (!installedText || installedText.type !== "text") throw new Error("Package management did not return a connection");
    const connection: McpConnectionDto = JSON.parse(installedText.text);
    const connect = async (entry: McpConnectionDto): Promise<InstanceType<typeof Client>> => {
      if (entry.transport.type !== "stdio") throw new Error("Expected a native stdio definition");
      const client = new Client({ name: "package-consumer", version: "1" });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: entry.transport.command, args: entry.transport.args, cwd: workspace,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, MANAGED_TOKEN: token }, stderr: "pipe" }));
      return client;
    };
    const result = async (client: InstanceType<typeof Client>) => {
      const response = await client.callTool({ name: "read", arguments: {} });
      return JSON.parse(response.content[0].text);
    };
    const first = await connect(connection);
    expect(await result(first)).toEqual({ value: "1", auth: createHash("sha256").update(token).digest("hex"), args: [] });
    if (connection.transport.type !== "stdio") throw new Error("Expected native launcher");
    const manifest = connection.transport.args[1]!;
    const installation = path.dirname(manifest);
    const current = async (): Promise<{ directory: string; entry: string }> => JSON.parse(await readFile(manifest, "utf8")).current;
    const initial = await current();
    const nativeBefore = await readFile(path.join(workspace, ".mcp.json"), "utf8");
    expect(nativeBefore).not.toContain(token);
    expect(JSON.stringify(await service.state())).not.toContain(token);
    expect(await readFile(manifest, "utf8")).not.toContain(token);
    // A partial lease write must protect a live process, then become
    // collectible after that process exits rather than retaining history.
    const leases = path.join(installation, "leases");
    await writeFile(path.join(leases, (await readdir(leases))[0]!), "{");

    latest = "2.0.0";
    const updated = await apiStatus(harness, "POST", `/api/plugins/mcp/${connection.id}/update`, {});
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ package: { version: "2.0.0" } });
    expect(service.packages.list()[0]?.package?.version).toBe("2.0.0");
    expect(await result(first)).toMatchObject({ value: "1" });
    const second = await connect(service.packages.list()[0]!);
    expect(await result(second)).toMatchObject({ value: "2" });
    expect(await readFile(path.join(workspace, ".mcp.json"), "utf8")).toBe(nativeBefore);
    await first.close();
    service.packages.collect();
    expect(existsSync(path.join(installation, "versions", initial.directory))).toBe(false);

    latest = "3.0.0";
    corrupt = true;
    await expect(service.updateMcp(connection.id)).rejects.toThrow("integrity");
    expect(service.packages.list()[0]?.package).toMatchObject({ version: "2.0.0", availableVersion: "3.0.0", updateStatus: "failed" });
    const retained = await connect(service.packages.list()[0]!);
    expect(await result(retained)).toMatchObject({ value: "2" });
    await retained.close();
    corrupt = false;
    const secondVersion = await current();
    const valueFile = path.join(installation, "versions", secondVersion.directory, "source", "value.txt");
    onArtifact = async () => { await writeFile(valueFile, "91"); };
    await expect(service.updateMcp(connection.id)).rejects.toThrow("local changes were retained");
    expect(service.packages.list()[0]?.package).toMatchObject({ version: "2.0.0", modified: true, updateStatus: "modified" });
    expect(await result(second)).toMatchObject({ value: "91" });
    onArtifact = undefined;
    latest = "4.0.0";
    await expect(service.updateMcp(connection.id)).rejects.toThrow("Local package content");
    expect(await readFile(valueFile, "utf8")).toBe("91");
    expect(service.packages.list()[0]?.package?.availableVersion).toBe("4.0.0");
    latest = "3.0.0";
    await writeFile(valueFile, "2");
    await service.packages.updateAll();
    expect(service.packages.list()[0]?.package?.version).toBe("3.0.0");
    const third = await connect(service.packages.list()[0]!);
    expect(await result(third)).toMatchObject({ value: "3" });
    await third.close();
    await second.close();
    service.packages.collect();
    expect((await readdir(path.join(installation, "versions"))).length).toBe(1);

    latest = "4.0.0";
    onArtifact = async () => {
      const nativeFile = path.join(workspace, ".mcp.json");
      const config = JSON.parse(await readFile(nativeFile, "utf8"));
      config.mcpServers.managed.args.push("native-edit");
      config.mcpServers.managed.disabled = true;
      await writeFile(nativeFile, JSON.stringify(config));
    };
    await expect(service.updateMcp(connection.id)).rejects.toThrow("native edit was retained");
    expect(service.packages.list()[0]).toMatchObject({ enabled: false, package: { version: "3.0.0", args: ["native-edit"] } });
    onArtifact = undefined;
    await service.packages.updateAll();
    expect(service.packages.list()[0]?.package?.version).toBe("3.0.0");
    await service.saveMcp(connection.id, { name: "managed", enabled: true, package: { name: packageName, args: ["explicit-edit"] } });
    expect(service.packages.list()[0]?.enabled).toBe(true);
    await lease.call("manage_plugins", { action: "update_mcp", id: connection.id }, new AbortController().signal);
    lease.release();
    const fourth = await connect(service.packages.list()[0]!);
    expect(await result(fourth)).toMatchObject({ value: "4", args: ["explicit-edit"] });

    latest = "5.0.0";
    await expect(service.updateMcp(connection.id)).rejects.toThrow("install-time scripts");
    expect(existsSync(canary)).toBe(false);
    expect(service.packages.list()[0]?.package?.version).toBe("4.0.0");
    latest = "6.0.0";
    const removedDefinition = await readFile(path.join(workspace, ".mcp.json"), "utf8");
    onArtifact = async () => { service!.removeMcp(connection.id); };
    await expect(service.updateMcp(connection.id)).rejects.toThrow("native edit was retained");
    expect(service.packages.list()).toEqual([]);
    expect(await result(fourth)).toMatchObject({ value: "4" });
    await writeFile(path.join(workspace, ".mcp.json"), removedDefinition);
    service.packages.collect();
    expect(service.packages.list()[0]?.package?.version).toBe("4.0.0");
    service.removeMcp(service.packages.list()[0]!.id);
    await fourth.close();
    service.packages.collect();
    expect(existsSync(installation)).toBe(false);
    expect((await readdir(path.join(home, "plugins", "mcp-packages"))).filter((name) => name !== "runner.cjs")).toEqual([]);

    // Package identity is a credential boundary even though both definitions
    // use the same stable Node launcher. Never attach A's secrets to package B.
    latest = "1.0.0";
    onArtifact = undefined;
    const scoped = await service.saveMcp(null, { name: "credential-scope", package: { name: packageName, env: { MANAGED_TOKEN: token } } });
    expect(scoped.transport).toMatchObject({ envKeys: ["MANAGED_TOKEN"] });
    latest = "7.0.0";
    const replaced = await service.saveMcp(scoped.id, { name: "credential-scope", package: { name: otherPackage } });
    expect(replaced.transport).toMatchObject({ envKeys: [] });
    await service.saveMcp(scoped.id, { name: "credential-scope", package: { name: otherPackage, env: { MANAGED_TOKEN: token } } });
    await mkdir(path.join(workspace, ".pi"), { recursive: true });
    await writeFile(path.join(workspace, ".pi/settings.json"), JSON.stringify({ packages: [path.resolve(daemon, "../../workers/pi/node_modules/pi-mcp-adapter")] }));
    await worker.start();
    const connected: NativeMcpControlResult = await worker.request({ type: "mcp.control", cwd: workspace, action: "connect", server: "credential-scope" }, 30_000);
    expect(connected.servers.find((entry) => entry.name === "credential-scope")).toMatchObject({ status: "connected", toolCount: 1 });
    expect(JSON.parse(await readFile(startup, "utf8"))).toEqual({ args: [], auth: createHash("sha256").update(token).digest("hex") });
    // Selecting another executable in the SAME immutable package version must
    // invalidate the real native runtime, not leave its cached old executable.
    await service.saveMcp(scoped.id, { name: "credential-scope", package: { name: otherPackage, bin: "alternate" } });
    const switched: NativeMcpControlResult = await worker.request({ type: "mcp.control", cwd: workspace, action: "connect", server: "credential-scope" }, 30_000);
    expect(switched.servers.find((entry) => entry.name === "credential-scope")).toMatchObject({ status: "connected", toolCount: 1 });
    expect(JSON.parse(await readFile(startup, "utf8"))).toEqual({ args: ["alternate"], auth: createHash("sha256").update(token).digest("hex") });
    const native = await service.saveMcp(scoped.id, { name: "credential-scope", transport: { type: "stdio", command: "node", args: [path.join(home, "fixture-1/package/server.mjs")] } });
    expect(native.transport).toMatchObject({ envKeys: [] });
    service.removeMcp(scoped.id);
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.allSettled(clients.map((client) => client.close()));
    await harness?.stop();
    await worker.stop();
    await rm(home, { recursive: true, force: true });
    if (harness) await rm(path.dirname(harness.svc.cfg.statusPath), { recursive: true, force: true });
  }
}, 120_000);

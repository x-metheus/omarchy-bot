import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { NpmMcpPackage, SaveMcpBody, type McpConnectionDto } from "@omarchy-bot/protocol";
import { redactToolErrorSummary } from "@omarchy-bot/agent-contract";
import { HttpError } from "../bots/bots.ts";
import { NativeMcpStore } from "./nativeMcp.ts";
import { ResourceArchive } from "./resourceArchive.ts";
import { ResourceFingerprint } from "./resourceFingerprint.ts";

const archive = new ResourceArchive("MCP package", 20_000, 100 * 1024 * 1024);
const Version = z.object({ directory: z.string().uuid(), entry: z.string(), version: z.string(), baseline: z.string().regex(/^[0-9a-f]{64}$/), bin: z.string() });
const Installation = z.object({
  format: z.literal(1), source: NpmMcpPackage.pick({ name: true, bin: true }), current: Version,
  availableVersion: z.string().optional(),
  updateStatus: z.enum(["current", "modified", "failed", "available"]), lastCheckedAt: z.string(),
  error: z.string().optional(), retired: z.boolean().default(false),
});
type Installation = z.infer<typeof Installation>;
const PublishedPackage = z.object({ name: z.string(), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/), dist: z.object({ tarball: z.string().url(), integrity: z.string() }) });
const PackageManifest = z.object({ name: z.string(), version: z.string(), bin: z.union([z.string(), z.record(z.string())]).optional(), scripts: z.record(z.string()).optional(), engines: z.object({ node: z.string().optional() }).optional(), dependencies: z.record(z.string()).optional(), optionalDependencies: z.record(z.string()).optional(), peerDependencies: z.record(z.string()).optional() }).passthrough();
const Lease = z.object({ pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/), directory: z.string().uuid().nullable() });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
}

/** Owns package content, not a business MCP runtime. Native clients execute the
 * same installed launcher; an OS-process lease protects only versions in use. */
export class McpPackages {
  readonly #root: string;
  readonly #runner: string;
  readonly #runnerRevision: string;
  readonly #fingerprint = new ResourceFingerprint({ kind: "MCP package", maxEntries: 40_000, maxBytes: 512 * 1024 * 1024, confineLinks: true });
  readonly #pending = new Map<string, Promise<McpConnectionDto>>();
  readonly #abort = new AbortController();
  readonly #busyRoots = new Set<string>();
  errors: string[] = [];

  constructor(private readonly native: NativeMcpStore) {
    this.#root = path.join(realpathSync(native.privateDir), "mcp-packages");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.#root).isDirectory() || lstatSync(this.#root).isSymbolicLink()) throw new Error("MCP packages require a private real directory");
    chmodSync(this.#root, 0o700);
    this.#runner = path.join(this.#root, "runner.cjs");
    const source = readFileSync(path.join(import.meta.dir, "mcpPackageRunner.cjs"));
    this.#runnerRevision = createHash("sha256").update(source).digest("hex");
    if (existsSync(this.#runner) && (!lstatSync(this.#runner).isFile() || lstatSync(this.#runner).isSymbolicLink())) throw new Error("MCP package launcher must be a private regular file");
    if (!existsSync(this.#runner) || !readFileSync(this.#runner).equals(source)) {
      const temporary = `${this.#runner}.${randomUUID()}.tmp`;
      writeFileSync(temporary, source, { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.#runner);
    }
  }

  #manifestRoot(connection: McpConnectionDto): string | undefined {
    if (connection.transport.type !== "stdio") return undefined;
    for (const argument of connection.transport.args) {
      const file = path.resolve(argument);
      if (path.basename(file) !== "current.json") continue;
      const root = path.dirname(file);
      if (path.dirname(root) === this.#root && uuid.test(path.basename(root))) return root;
    }
    return undefined;
  }

  #record(root: string): Installation {
    if (realpathSync(root) !== root) throw new Error("MCP installation contains a linked directory");
    const file = path.join(root, "current.json");
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("MCP package metadata must be a private regular file");
    return Installation.parse(JSON.parse(readFileSync(file, "utf8")));
  }

  #canonical(connection: McpConnectionDto, root: string): boolean {
    return connection.transport.type === "stdio" && connection.transport.command === "node"
      && connection.transport.args[0] === this.#runner && connection.transport.args[1] === path.join(root, "current.json")
      && !connection.readOnly && connection.status !== "conflict";
  }

  #runtimeRevision(current: z.infer<typeof Version>): string {
    return `${current.entry}:${current.version}:${current.baseline}:${this.#runnerRevision}`;
  }

  #versionPath(root: string, record: Installation): string {
    const directory = path.join(root, "versions", record.current.directory);
    if (realpathSync(directory) !== directory) throw new Error("MCP package version contains a linked directory");
    return directory;
  }

  #clean(root: string, record: Installation): boolean {
    try { return this.#fingerprint.digest(this.#versionPath(root, record)) === record.current.baseline; }
    catch { return false; }
  }

  #decorate(connection: McpConnectionDto): McpConnectionDto {
    const root = this.#manifestRoot(connection);
    if (!root) return connection;
    try {
      const record = this.#record(root);
      if (record.retired) return { ...connection, status: "error", error: "This managed package was removed; select an installed source" };
      const edited = !this.#canonical(connection, root);
      const modified = edited || !this.#clean(root, record);
      return { ...connection, package: {
        name: record.source.name, bin: record.current.bin,
        args: connection.transport.type === "stdio" ? connection.transport.args.slice(connection.transport.args.indexOf(path.join(root, "current.json")) + 1) : [],
        version: record.current.version, modified,
        updateStatus: modified ? "modified" : record.updateStatus === "modified" ? record.availableVersion && record.availableVersion !== record.current.version ? "available" : "current" : record.updateStatus, lastCheckedAt: record.lastCheckedAt,
        ...(record.availableVersion ? { availableVersion: record.availableVersion } : {}),
        ...(modified ? { error: edited ? "The native package launcher was edited. Restore or explicitly replace it before package updates." : "Local MCP package changes were retained; review them before updating." } : record.error ? { error: record.error } : {}),
      } };
    } catch { return { ...connection, status: "error", error: "Managed MCP package metadata is unavailable or invalid; existing files were retained" }; }
  }

  list(): McpConnectionDto[] { return this.native.list().map((connection) => this.#decorate(connection)); }

  save(id: string | null, input: SaveMcpBody, signal?: AbortSignal): Promise<McpConnectionDto> {
    const body = SaveMcpBody.parse(input);
    const key = id ?? `name:${body.name}`;
    if (this.#pending.has(key)) throw new HttpError(409, "An MCP package operation is already in progress for this connection");
    const operation = this.#save(id, body, signal).finally(() => this.#pending.delete(key));
    this.#pending.set(key, operation);
    return operation;
  }

  async #save(id: string | null, body: z.output<typeof SaveMcpBody>, requestedSignal?: AbortSignal): Promise<McpConnectionDto> {
    this.#abort.signal.throwIfAborted();
    const previous = id ? this.native.list().find((connection) => connection.id === id) : undefined;
    if (id && !previous) throw new HttpError(404, "Native MCP connection not found");
    if (previous?.readOnly || previous?.status === "conflict" || this.native.errors.length) throw new HttpError(409, "Resolve native MCP configuration conflicts before changing its package");
    if ("transport" in body) {
      const nativeBody = previous && this.#manifestRoot(previous) && body.transport.type === "stdio"
        ? { ...body, transport: { ...body.transport, env: body.transport.env ?? {} } } : body;
      const result = this.native.save(id, nativeBody);
      this.native.setPackageRevision(result.id, undefined);
      this.collect();
      return result;
    }
    if (!id && this.native.list(true).some((entry) => entry.name === body.name)) throw new HttpError(409, "A native MCP already uses that name");
    const existingRoot = previous ? this.#manifestRoot(previous) : undefined;
    const root = existingRoot ?? path.join(this.#root, randomUUID());
    if (this.#busyRoots.has(root)) throw new HttpError(409, "This MCP package installation is already being updated");
    let record = existingRoot ? this.#record(existingRoot) : undefined;
    if (record && previous && !this.#canonical(previous, root)) {
      record.updateStatus = "modified"; record.lastCheckedAt = new Date().toISOString();
      record.error = "Local package content or native configuration is preserved. Review it before replacing this installation.";
      atomicJson(path.join(root, "current.json"), record);
      throw new HttpError(409, record.error);
    }
    const signal = requestedSignal ? AbortSignal.any([requestedSignal, this.#abort.signal]) : this.#abort.signal;
    this.#busyRoots.add(root);
    let published = false;
    try {
      mkdirSync(path.join(root, "versions"), { recursive: true, mode: 0o700 });
      const source = { ...body.package, bin: body.package.bin ?? (record?.source.name === body.package.name ? record.current.bin : undefined) };
      const latest = PublishedPackage.parse(JSON.parse((await archive.download(new URL(`https://registry.npmjs.org/${encodeURIComponent(source.name)}/latest`), signal)).toString("utf8")));
      if (latest.name !== source.name) throw new Error("npm returned a different package identity");
      if (record) {
        record = { ...record, ...(record.source.name === source.name ? { availableVersion: latest.version } : {}), lastCheckedAt: new Date().toISOString() };
        atomicJson(path.join(root, "current.json"), record);
        if (!this.#clean(root, record)) throw new HttpError(409, "Local package content is preserved. Review it before replacing this installation.");
      }
      let current = record?.source.name === source.name && record.current.version === latest.version && record.current.bin === source.bin ? record.current : undefined;
      if (!current) current = await this.#install(root, source, latest, signal);
      signal.throwIfAborted();
      const actual = id ? this.native.list().find((connection) => connection.id === id) : undefined;
      if (id && (!actual || !previous || actual.readOnly || actual.status === "conflict" || this.native.errors.length || actual.name !== previous.name || !isDeepStrictEqual(actual.transport, previous.transport))) throw new HttpError(409, "The MCP definition changed during package installation; the native edit was retained");
      if (record && !this.#clean(root, record)) throw new HttpError(409, "MCP package changed during update; local changes were retained");
      const next: Installation = { format: 1, source: { name: source.name, bin: current.bin }, current,
        updateStatus: "current", lastCheckedAt: new Date().toISOString(), retired: false };
      // Publish a complete immutable version before exposing its stable native
      // launcher. A failed projection cannot point at an incomplete directory.
      atomicJson(path.join(root, "current.json"), next);
      published = true;
      const result = this.native.save(id, { name: body.name, enabled: actual && actual.enabled !== previous?.enabled ? actual.enabled : body.enabled,
        transport: { type: "stdio", command: "node", args: [this.#runner, path.join(root, "current.json"), ...body.package.args],
          ...(body.package.env !== undefined ? { env: body.package.env } : record?.source.name === source.name ? {} : { env: {} }) } });
      this.native.setPackageRevision(result.id, this.#runtimeRevision(current));
      return this.#decorate(this.native.list().find((entry) => entry.id === result.id)!);
    } catch (error) {
      if (record) {
        const current = record;
        current.updateStatus = this.#clean(root, current) ? "failed" : "modified";
        current.lastCheckedAt = new Date().toISOString();
        current.error = redactToolErrorSummary(error instanceof Error ? error.message : error);
        atomicJson(path.join(root, "current.json"), current);
      } else if (!published) rmSync(root, { recursive: true, force: true });
      throw error instanceof HttpError ? error : new HttpError(502, redactToolErrorSummary(error instanceof Error ? error.message : error));
    } finally { this.#busyRoots.delete(root); this.collect(); }
  }

  async #command(args: string[], cwd: string, home: string, signal: AbortSignal): Promise<string> {
    const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", timeout: 120_000, signal,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
        BUN_INSTALL_CACHE_DIR: path.join(home, "bun"), npm_config_cache: path.join(home, "npm"),
        npm_config_userconfig: path.join(home, ".npmrc"), npm_config_registry: "https://registry.npmjs.org/",
        TMPDIR: home, LANG: "C", LC_ALL: "C" } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`MCP package dependency or executable preparation failed: ${stderr.trim().slice(-1500) || `exit ${code}`}`);
    return stdout;
  }

  #validateManifest(manifest: z.infer<typeof PackageManifest>, nodeVersion: string): void {
    if (["preinstall", "install", "postinstall"].some((script) => manifest.scripts?.[script])) throw new Error(`Package ${manifest.name} declares install-time scripts; a prebuilt Node-compatible package is required`);
    if (manifest.engines?.node && !Bun.semver.satisfies(nodeVersion, manifest.engines.node)) throw new Error(`Package ${manifest.name} requires Node ${manifest.engines.node}; this runtime is Node ${nodeVersion}`);
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
      NpmMcpPackage.shape.name.parse(name);
      const alias = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([^:/\\]+))?$/.test(version);
      if (!version || (!alias && /[:/\\]/.test(version))) throw new Error(`Package ${manifest.name} uses an unsupported non-registry dependency source`);
    }
  }

  async #install(root: string, source: NpmMcpPackage, latest: z.infer<typeof PublishedPackage>, signal: AbortSignal): Promise<z.infer<typeof Version>> {
    const staging = await mkdtemp(path.join(this.#root, ".install-"));
    try {
      const target = path.join(staging, "content");
      const home = path.join(staging, "home");
      const extracted = path.join(staging, "extracted");
      await Promise.all([mkdir(target, { mode: 0o700 }), mkdir(home, { mode: 0o700 }), mkdir(extracted, { mode: 0o700 })]);
      const nodeVersion = (await this.#command(["node", "-e", "if(Number(process.versions.node.split('.')[0])<24||typeof process.execve!=='function')throw Error('Managed MCP packages require Node 24 or newer with process.execve');process.stdout.write(process.versions.node)"], staging, home, signal)).trim();
      const url = new URL(latest.dist.tarball);
      if (url.origin !== "https://registry.npmjs.org") throw new Error("npm package artifacts must come from the official registry");
      const integrity = latest.dist.integrity.split(/\s+/).find((value) => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value));
      if (!integrity) throw new Error("The npm package must publish SHA-512 artifact integrity");
      const bytes = await archive.download(url, signal);
      if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) throw new Error("npm package artifact integrity verification failed");
      await archive.extract(bytes, staging, extracted);
      const entries = readdirSync(extracted);
      if (entries.length !== 1 || entries[0] !== "package") throw new Error("npm package archive must contain one package root");
      const packageDir = path.join(target, "source");
      renameSync(path.join(extracted, "package"), packageDir);
      const manifest = PackageManifest.parse(JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")));
      if (manifest.name !== latest.name || manifest.version !== latest.version) throw new Error("npm package archive identity differs from its published version");
      this.#validateManifest(manifest, nodeVersion);
      const bins = typeof manifest.bin === "string" ? { [manifest.name.split("/").at(-1)!]: manifest.bin } : manifest.bin ?? {};
      const names = Object.keys(bins);
      const bin = source.bin ?? (names.includes(manifest.name.split("/").at(-1)!) ? manifest.name.split("/").at(-1)! : names.length === 1 ? names[0] : undefined);
      if (!bin || !bins[bin]) throw new Error(`Select an executable published by this npm package${names.length ? `: ${names.join(", ")}` : "; no executable is published"}`);
      NpmMcpPackage.shape.bin.parse(bin);
      const relativeEntry = archive.relativeFile(bins[bin]);
      await writeFile(path.join(target, "package.json"), JSON.stringify({ name: "omarchy-bot-managed-mcp", private: true, dependencies: { [source.name]: "file:./source" } }), { mode: 0o600 });
      await writeFile(path.join(home, ".npmrc"), "registry=https://registry.npmjs.org/\n", { mode: 0o600 });
      await this.#command([process.execPath, "install", "--production", "--ignore-scripts", "--no-progress"], target, home, signal);
      const seen = new Set<string>();
      const inspectModules = (directory: string): void => {
        if (!existsSync(directory)) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const candidate = path.join(directory, entry.name);
          if (entry.name.startsWith("@")) { inspectModules(candidate); continue; }
          const actual = realpathSync(candidate);
          if (!within(target, actual)) throw new Error("MCP dependency points outside its private installation");
          if (seen.has(actual)) continue;
          seen.add(actual);
          this.#validateManifest(PackageManifest.parse(JSON.parse(readFileSync(path.join(actual, "package.json"), "utf8"))), nodeVersion);
          inspectModules(path.join(actual, "node_modules"));
        }
      };
      inspectModules(path.join(target, "node_modules"));
      // Directory dependencies may be linked by Bun. Convert only verified
      // internal links to relative paths so atomic version moves remain valid.
      const relocateLinks = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) {
            const destination = realpathSync(file);
            if (!within(target, destination)) throw new Error("MCP dependency links outside its private installation");
            if (path.isAbsolute(readlinkSync(file))) { unlinkSync(file); symlinkSync(path.relative(path.dirname(file), destination), file); }
          } else if (entry.isDirectory()) relocateLinks(file);
        }
      };
      relocateLinks(target);
      const entry = path.join("node_modules", source.name, relativeEntry);
      const executable = realpathSync(path.join(target, entry));
      if (!within(target, executable) || !lstatSync(executable).isFile()) throw new Error("MCP package executable is not a contained regular file");
      await this.#command(["node", "--check", executable], target, home, signal);
      const baseline = this.#fingerprint.digest(target);
      signal.throwIfAborted();
      const directory = randomUUID();
      renameSync(target, path.join(root, "versions", directory));
      return { directory, entry, version: latest.version, baseline, bin };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  update(id: string, signal?: AbortSignal): Promise<McpConnectionDto> {
    const connection = this.native.list().find((entry) => entry.id === id);
    if (!connection) throw new HttpError(404, "Native MCP connection not found");
    const root = this.#manifestRoot(connection);
    if (!root || !this.#canonical(connection, root) || connection.transport.type !== "stdio") throw new HttpError(409, "Select a managed npm MCP package with an unchanged native launcher");
    const record = this.#record(root);
    return this.save(id, { name: connection.name, enabled: connection.enabled, package: { name: record.source.name, bin: record.current.bin, args: connection.transport.args.slice(2) } }, signal);
  }

  async updateAll(): Promise<void> {
    const roots = new Set<string>();
    const failures: string[] = [];
    for (const connection of this.native.list()) {
      if (this.#abort.signal.aborted) break;
      const root = this.#manifestRoot(connection);
      if (!connection.enabled || !root || roots.has(root)) continue;
      roots.add(root);
      try { await this.update(connection.id); } catch { failures.push(connection.name); }
    }
    if (failures.length) throw new HttpError(502, `MCP package updates need attention: ${failures.join(", ")}`);
  }

  remove(id: string): void { this.native.remove(id); this.collect(); }

  collect(): void {
    this.errors = [];
    const connections = this.native.list();
    if (this.native.errors.length || connections.some((connection) => connection.status === "conflict")) return;
    const references = new Map<string, McpConnectionDto[]>();
    for (const connection of connections) {
      const root = this.#manifestRoot(connection);
      if (root) references.set(root, [...(references.get(root) ?? []), connection]);
    }
    for (const directory of readdirSync(this.#root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !uuid.test(directory.name)) continue;
      const root = path.join(this.#root, directory.name);
      if (this.#busyRoots.has(root)) continue;
      try {
        const record = this.#record(root);
        const refs = references.get(root) ?? [];
        if (record.retired !== (refs.length === 0)) { record.retired = refs.length === 0; atomicJson(path.join(root, "current.json"), record); }
        if (refs.length && !record.retired) {
          const revision = this.#runtimeRevision(record.current);
          for (const connection of refs) this.native.setPackageRevision(connection.id, revision);
        }
        const held = new Set<string>();
        let selecting = false;
        const leases = path.join(root, "leases");
        if (existsSync(leases)) {
          if (realpathSync(leases) !== leases) throw new Error("MCP package leases contain an unsafe link");
          for (const name of readdirSync(leases)) {
            const file = path.join(leases, name);
            let lease: z.infer<typeof Lease>;
            try { lease = Lease.parse(JSON.parse(readFileSync(file, "utf8"))); }
            catch {
              // A crash can interrupt the tiny lease write. Its generated
              // filename still identifies the process; delete only after that
              // PID is absent, never on an unreadable or reused live PID.
              const pid = /^([1-9][0-9]*)-[0-9a-f-]{36}\.json$/.exec(name)?.[1];
              try { if (pid) readFileSync(`/proc/${pid}/stat`, "utf8"); }
              catch (error) {
                if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) { unlinkSync(file); continue; }
              }
              selecting = true; continue;
            }
            let live = false;
            try {
              const stat = readFileSync(`/proc/${lease.pid}/stat`, "utf8");
              const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
              live = fields[19] === lease.startTime && fields[0] !== "Z";
            } catch (error) {
              if (!(error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH"))) { selecting = true; continue; }
            }
            if (!live) { unlinkSync(file); continue; }
            if (lease.directory === null) selecting = true; else held.add(lease.directory);
          }
        }
        if (selecting) continue;
        const versions = path.join(root, "versions");
        for (const version of readdirSync(versions, { withFileTypes: true })) {
          if (!version.isDirectory() || !uuid.test(version.name) || held.has(version.name) || (!record.retired && version.name === record.current.directory)) continue;
          rmSync(path.join(versions, version.name), { recursive: true, force: true });
        }
        if (record.retired && held.size === 0) rmSync(root, { recursive: true, force: true });
      } catch { this.errors.push("An MCP package could not be safely reconciled; its content was retained"); }
    }
  }

  async shutdown(): Promise<void> {
    this.#abort.abort();
    await Promise.allSettled(this.#pending.values());
    this.collect();
  }
}

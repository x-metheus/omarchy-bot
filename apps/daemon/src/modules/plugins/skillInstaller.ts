import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ResourceArchive } from "./resourceArchive.ts";
import type { CatalogSkillDetailDto, CatalogSkillDto, InstallSkillBody } from "@omarchy-bot/protocol";

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 2000;
const resources = new ResourceArchive("Skill", MAX_FILES, MAX_BYTES);


export function skillFrontmatter(contents: string): { name: string; description: string } {
  const header = contents.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!header) throw new Error("SKILL.md has no YAML frontmatter");
  const fields: unknown = parseYaml(header[1]!, { maxAliasCount: 0 });
  if (!fields || typeof fields !== "object" || !("name" in fields) || !("description" in fields)
    || typeof fields.name !== "string" || typeof fields.description !== "string" || !fields.name.trim() || !fields.description.trim()) {
    throw new Error("SKILL.md must declare a name and description");
  }
  return { name: fields.name.trim(), description: fields.description.trim() };
}


async function git(args: string[], cwd: string, home: string): Promise<Buffer> {
  const process = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args], {
    cwd, stdout: "pipe", stderr: "pipe", timeout: 120_000,
    env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, LANG: "C", LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
  });
  const [stdout, stderr, status] = await Promise.all([new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text(), process.exited]);
  if (status !== 0) throw new Error(`Git skill retrieval failed: ${stderr.slice(-1000).trim() || `exit ${status}`}`);
  if (stdout.byteLength > MAX_BYTES) throw new Error("Skill file exceeds the installation limit");
  return Buffer.from(stdout);
}

async function installGithub(detail: Pick<CatalogSkillDetailDto, "id" | "installUrl" | "source">, staging: string, target: string, selection?: { directory?: string; ref?: string }): Promise<string> {
  const source = new URL(detail.installUrl);
  if (source.hostname !== "github.com" || source.protocol !== "https:" || source.username || source.password || source.search || source.hash
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(detail.source)
    || source.pathname.replace(/^\//, "").replace(/\.git$/, "").replace(/\/$/, "") !== detail.source) throw new Error("Catalog GitHub source identity does not match its repository");
  const repository = path.join(staging, "repository");
  await git(["clone", "--depth=1", "--no-checkout", "--filter=blob:limit=1048576", "--template=", `https://github.com/${detail.source}.git`, repository], staging, staging);
  if (selection?.ref) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(selection.ref) || selection.ref.includes("..")) throw new Error("Unsupported Git revision syntax");
    await git(["fetch", "--depth=1", "origin", selection.ref], repository, staging);
    await git(["update-ref", "HEAD", "FETCH_HEAD"], repository, staging);
  }
  const commit = (await git(["rev-parse", "HEAD"], repository, staging)).toString().trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Git did not resolve an immutable source revision");
  const tree = (await git(["ls-tree", "-rz", "--full-tree", commit], repository, staging)).toString();
  const entries = tree.split("\0").filter(Boolean).map((entry) => {
    const match = entry.match(/^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/);
    if (!match) throw new Error("Invalid Git tree entry");
    return { mode: match[1]!, type: match[2]!, hash: match[3]!, file: resources.relativeFile(match[4]!) };
  });
  const slug = detail.id.split("/").at(-1)!;
  const candidates = entries.filter((entry) => entry.file === "SKILL.md" || entry.file.endsWith("/SKILL.md"));
  if (candidates.length > MAX_FILES) throw new Error("Repository contains too many skill definitions");
  const matches: typeof candidates = [];
  for (const candidate of candidates) {
    if (candidate.type !== "blob" || !["100644", "100755"].includes(candidate.mode)) continue;
    if (selection) {
      if (selection.directory === undefined || path.posix.dirname(candidate.file) === (selection.directory || ".")) matches.push(candidate);
      continue;
    }
    const contents = (await git(["cat-file", "blob", candidate.hash], repository, staging)).toString();
    let metadata: { name: string; description: string };
    try { metadata = skillFrontmatter(contents); } catch { continue; }
    const normalizedName = metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (normalizedName === slug || metadata.name === slug) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error(matches.length ? "Repository contains multiple matching Skills; select an exact skillPath" : "The selected Skill was not found in the current repository revision");
  const skillFile = matches[0]!.file;
  const directory = path.posix.dirname(skillFile);
  const prefix = directory === "." ? "" : `${directory}/`;
  const assets = entries.filter((entry) => entry.file.startsWith(prefix));
  if (assets.length > MAX_FILES) throw new Error("Skill contains more than 2000 supporting files");
  let total = 0;
  for (const asset of assets) {
    if (asset.type !== "blob" || !["100644", "100755"].includes(asset.mode)) throw new Error("Skill contains symlinks or submodules; those cannot be installed safely as a self-contained folder");
    const size = Number((await git(["cat-file", "-s", asset.hash], repository, staging)).toString());
    if (!Number.isSafeInteger(size) || size < 0 || total + size > MAX_BYTES) throw new Error("Skill exceeds the 100 MiB installation limit");
    const bytes = await git(["cat-file", "blob", asset.hash], repository, staging);
    if (bytes.subarray(0, 128).toString().startsWith("version https://git-lfs.github.com/spec/v1")) throw new Error("Skill uses Git LFS assets; the complete asset is required, not an LFS pointer");
    total += bytes.length;
    const destination = path.join(target, resources.relativeFile(asset.file.slice(prefix.length)));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: asset.mode === "100755" ? 0o700 : 0o600, flag: "wx" });
  }
  return `git:${commit}:${directory}`;
}


async function installWellKnown(detail: Pick<CatalogSkillDetailDto, "id" | "installUrl" | "source">, staging: string, target: string): Promise<string> {
  const base = new URL(detail.installUrl);
  if (base.hostname !== detail.source || base.protocol !== "https:") throw new Error("Catalog well-known source identity does not match its origin");
  let indexUrl = new URL("/.well-known/agent-skills/index.json", base);
  let response = await fetch(indexUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) {
    indexUrl = new URL("/.well-known/skills/index.json", base);
    response = await fetch(indexUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  }
  if (!response.ok) throw new Error(`Skill discovery returned HTTP ${response.status}`);
  const index = await response.json() as { skills?: unknown[] };
  if (!Array.isArray(index.skills)) throw new Error("Skill source has no valid discovery index");
  const slug = detail.id.split("/").at(-1)!;
  const matches = index.skills.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && "name" in entry && entry.name === slug);
  if (matches.length !== 1) throw new Error("The exact skill is missing or ambiguous in its source index");
  const skill = matches[0]!;
  if (typeof skill.url === "string" && typeof skill.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(skill.digest)) {
    const bytes = await resources.download(new URL(skill.url, indexUrl));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== skill.digest) throw new Error("Skill artifact does not match its published SHA-256 digest");
    if (skill.type === "skill-md") await writeFile(path.join(target, "SKILL.md"), bytes, { mode: 0o600, flag: "wx" });
    else if (skill.type === "archive") await resources.extract(bytes, staging, target);
    else throw new Error("Unsupported skill artifact type");
    return digest;
  }
  if (!Array.isArray(skill.files) || !skill.files.length || skill.files.length > MAX_FILES || skill.files.some((file) => typeof file !== "string")) throw new Error("Unsupported or incomplete skill discovery record");
  const names = new Set<string>();
  const hash = createHash("sha256");
  let size = 0;
  for (const name of [...skill.files].sort()) {
    const safe = resources.relativeFile(name);
    if (names.has(safe)) throw new Error("Skill index contains duplicate file paths");
    names.add(safe);
    const bytes = await resources.download(new URL(`${encodeURIComponent(slug)}/${safe.split("/").map(encodeURIComponent).join("/")}`, indexUrl));
    size += bytes.length;
    if (size > MAX_BYTES) throw new Error("Skill exceeds the 100 MiB installation limit");
    const destination = path.join(target, safe);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    hash.update(safe).update("\0").update(bytes).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function secureTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("Skill installation contains an unsafe filesystem entry");
    const info = await lstat(file);
    await chmod(file, entry.isDirectory() || (info.mode & 0o111) !== 0 ? 0o700 : 0o600);
    if (entry.isDirectory()) await secureTree(file);
  }
}

export async function materializeSkill(detail: CatalogSkillDetailDto, rootDir: string): Promise<{ directory: string; revision: string; name: string; description: string }> {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const staging = path.join(rootDir, `.staging-${randomUUID()}`);
  const target = path.join(staging, "skill");
  await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    const revision = detail.sourceType === "github" ? await installGithub(detail, staging, target) : await installWellKnown(detail, staging, target);
    const metadata = skillFrontmatter(await readFile(path.join(target, "SKILL.md"), "utf8"));
    await secureTree(target);
    const directory = path.join(rootDir, createHash("sha256").update(detail.id).update("\0").update(revision).digest("hex"));
    try { await rename(target, directory); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code)))) throw error;
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Existing skill revision has an unsafe destination");
    }
    return { directory, revision, ...metadata };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** Materialize one explicitly selected source without depending on catalog registration. */
export interface MaterializedSkillSource {
  catalog: CatalogSkillDto;
  directory: string;
  revision: string;
}

export async function materializeSkillSource(input: Exclude<InstallSkillBody, { id: string }>, rootDir: string): Promise<MaterializedSkillSource> {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const staging = path.join(rootDir, `.source-${randomUUID()}`);
  const target = path.join(staging, "skill");
  await mkdir(target, { recursive: true, mode: 0o700 });
  let sourceType: CatalogSkillDto["sourceType"];
  let source: string;
  let installUrl = input.source;
  let revision: string;
  try {
    if (path.isAbsolute(input.source)) {
      if (input.ref) throw new Error("Local Skill sources do not accept a Git revision");
      const selected = input.skillPath ? path.join(input.source, resources.relativeFile(input.skillPath)) : input.source;
      const sourceInfo = await lstat(selected);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("Select a real local Skill directory, not a link");
      sourceType = "local";
      source = selected;
      installUrl = selected;
      const hash = createHash("sha256");
      let count = 0;
      let bytes = 0;
      const copy = async (directory: string): Promise<void> => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (++count > MAX_FILES) throw new Error("Skill contains more than 2000 resources");
          if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Local Skill contains an unsafe linked or special resource");
          const file = path.join(directory, entry.name);
          const relative = resources.relativeFile(path.relative(selected, file));
          const destination = path.join(target, relative);
          if (entry.isDirectory()) { await mkdir(destination, { recursive: true, mode: 0o700 }); await copy(file); continue; }
          const info = await lstat(file);
          if (!info.isFile() || bytes + info.size > MAX_BYTES) throw new Error("Local Skill exceeds installation limits or changed during import");
          const contents = await readFile(file);
          bytes += contents.length;
          if (bytes > MAX_BYTES) throw new Error("Local Skill exceeds the 100 MiB installation limit");
          await writeFile(destination, contents, { flag: "wx", mode: info.mode & 0o111 ? 0o700 : 0o600 });
          hash.update(relative).update("\0").update(contents).update("\0");
        }
      };
      await copy(selected);
      revision = `sha256:${hash.digest("hex")}`;
    } else {
      const url = new URL(input.source);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Explicit remote Skill sources require an HTTPS URL without credentials or query parameters");
      if (url.hostname === "github.com") {
        const parts = url.pathname.replace(/\/$/, "").split("/").filter(Boolean).map(decodeURIComponent);
        if (parts.length < 2 || !parts.slice(0, 2).every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) throw new Error("Select a GitHub repository and exact Skill directory");
        sourceType = "github";
        source = `${parts[0]}/${parts[1]!.replace(/\.git$/, "")}`;
        let ref = input.ref;
        let directory = input.skillPath;
        if (parts.length > 2) {
          if (!["tree", "blob"].includes(parts[2]!)) throw new Error("Use a GitHub tree or SKILL.md URL");
          ref ??= parts[3];
          const suffix = parts.slice(3).join("/");
          if (!ref || (suffix !== ref && !suffix.startsWith(`${ref}/`))) throw new Error("The requested Git revision does not match the source URL");
          directory ??= suffix.slice(ref.length).replace(/^\//, "").replace(/(?:^|\/)SKILL\.md$/, "");
        }
        if (directory) directory = resources.relativeFile(directory);
        const selection = { ...(directory === undefined ? {} : { directory }), ...(ref === undefined ? {} : { ref }) };
        revision = await installGithub({ id: "", source, installUrl: `https://github.com/${source}` }, staging, target, selection);
        const resolvedDirectory = revision.slice(revision.indexOf(":", 4) + 1);
        installUrl = `https://github.com/${source}/tree/${ref ?? "HEAD"}/${resolvedDirectory}`;
      } else {
        if (input.ref) throw new Error("Only GitHub sources accept a Git revision");
        sourceType = "well-known";
        source = url.hostname;
        if (/\.(?:zip|tar|tar\.gz|tgz)$/i.test(url.pathname)) {
          const bytes = await resources.download(url);
          await resources.extract(bytes, staging, target);
          if (input.skillPath) {
            const selected = path.join(target, resources.relativeFile(input.skillPath));
            const selectedTarget = path.join(staging, "selected");
            await rename(selected, selectedTarget);
            await rm(target, { recursive: true });
            await rename(selectedTarget, target);
          }
          revision = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        } else {
          const name = input.skillPath ?? url.pathname.replace(/\/SKILL\.md$/, "").split("/").filter(Boolean).at(-1);
          if (!name || name.includes("/")) throw new Error("Select a Skill name from the source's published discovery index");
          revision = await installWellKnown({ id: `${source}/${name}`, source, installUrl: url.origin }, staging, target);
        }
      }
    }
    const metadata = skillFrontmatter(await readFile(path.join(target, "SKILL.md"), "utf8"));
    await secureTree(target);
    const id = `source_${createHash("sha256").update(installUrl).digest("hex").slice(0, 24)}`;
    const directory = path.join(rootDir, createHash("sha256").update(id).update("\0").update(revision).digest("hex"));
    try { await rename(target, directory); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code)))) throw error;
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Existing Skill source has an unsafe destination");
    }
    return { catalog: { id, ...metadata, sourceType, source, installUrl, ...(input.skillPath === undefined || sourceType !== "well-known" ? {} : { skillPath: input.skillPath }) }, directory, revision };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

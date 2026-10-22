import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

/** Content and executable-mode baselines, cached only while filesystem identity matches. */
export class ResourceFingerprint {
  #digests = new Map<string, { stamp: string; digest: string }>();
  constructor(private readonly options: { kind: string; maxEntries: number; maxBytes: number; confineLinks?: boolean }) {}

  digest(directory: string): string {
    const hash = createHash("sha256");
    let count = 0;
    let bytes = 0;
    const visit = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && entry.name === "__pycache__") continue;
        if (++count > this.options.maxEntries) throw new Error(`${this.options.kind} contains too many entries`);
        const file = path.join(current, entry.name);
        const relative = path.relative(directory, file);
        const info = lstatSync(file, { bigint: true });
        hash.update(relative).update("\0");
        if (entry.isSymbolicLink()) {
          if (this.options.confineLinks) {
            const target = path.relative(directory, realpathSync(file));
            if (target === ".." || target.startsWith(`..${path.sep}`) || path.isAbsolute(target)) throw new Error(`${this.options.kind} contains a link outside its installation`);
          }
          hash.update(`link:${readlinkSync(file)}`);
          continue;
        }
        if (entry.isDirectory()) { hash.update("directory\0"); visit(file); continue; }
        if (!entry.isFile()) throw new Error(`${this.options.kind} contains a non-regular resource`);
        bytes += Number(info.size);
        if (bytes > this.options.maxBytes) throw new Error(`${this.options.kind} exceeds the resource size limit`);
        const stamp = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`;
        let cached = this.#digests.get(file);
        if (cached?.stamp !== stamp) {
          cached = { stamp, digest: createHash("sha256").update(readFileSync(file)).digest("hex") };
          this.#digests.set(file, cached);
        }
        hash.update(cached.digest).update(String(info.mode & 0o111n)).update("\0");
      }
    };
    visit(directory);
    if (this.#digests.size > this.options.maxEntries * 4) this.#digests.clear();
    return hash.digest("hex");
  }
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { Parser, x as extractTar } from "tar";

/** One bounded, link-free acquisition path for installed plugin resources. */
export class ResourceArchive {
  constructor(private readonly kind: string, private readonly maxFiles: number, private readonly maxBytes: number) {}

  relativeFile(value: string): string {
    if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)
      || value.split("/").some((part) => part === ".." || part === ".git")) throw new Error(`${this.kind} contains an unsafe file path`);
    const normalized = path.posix.normalize(value).replace(/^\.\//, "").replace(/\/$/, "");
    if (normalized === "." || !normalized) throw new Error(`${this.kind} contains an empty file path`);
    return normalized;
  }

  async download(url: URL, signal?: AbortSignal): Promise<Buffer> {
    if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${this.kind} sources must use HTTPS without embedded credentials`);
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000), redirect: "error" });
    if (!response.ok) throw new Error(`${this.kind} source returned HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > this.maxBytes) throw new Error(`${this.kind} source exceeds the installation limit`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${this.kind} source returned no content`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > this.maxBytes) throw new Error(`${this.kind} source exceeds the installation limit`);
        chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks, size);
  }

  async extract(bytes: Uint8Array, staging: string, target: string): Promise<void> {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      let total = 0;
      const names = new Set<string>();
      const files = unzipSync(bytes, { filter: (entry) => {
        const file = this.relativeFile(entry.name);
        if (names.has(file)) throw new Error(`${this.kind} archive contains duplicate paths`);
        names.add(file);
        total += entry.originalSize;
        if (total > this.maxBytes || names.size > this.maxFiles) throw new Error(`${this.kind} archive exceeds installation limits`);
        return !entry.name.endsWith("/");
      } });
      for (const [name, content] of Object.entries(files)) {
        const destination = path.join(target, this.relativeFile(name));
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content, { flag: "wx", mode: 0o600 });
      }
      return;
    }
    // Validate fully before extraction: asynchronous filter throws or an unpack
    // abort can otherwise race filesystem writes from earlier archive entries.
    await new Promise<void>((resolve, reject) => {
      let total = 0;
      const entries = new Map<string, string>();
      const parser = new Parser({ strict: true, filter: (name, entry) => {
        try {
          if (!("type" in entry)) throw new Error("Tar parser did not provide archive entry metadata");
          if (entry.type === "Directory" && (name === "." || name === "./")) return false;
          const safe = this.relativeFile(name);
          if (!["File", "Directory", "OldFile"].includes(entry.type)) throw new Error(`${this.kind} archive contains links or unsupported filesystem entries`);
          if (entries.has(safe) && (entry.type !== "Directory" || entries.get(safe) !== "Directory")) throw new Error(`${this.kind} archive contains duplicate paths`);
          entries.set(safe, entry.type);
          if (entry.type !== "Directory") total += entry.size;
          if (entries.size > this.maxFiles || total > this.maxBytes) throw new Error(`${this.kind} archive exceeds installation limits`);
        } catch (error) { parser.abort(error instanceof Error ? error : new Error(String(error))); }
        return false;
      } });
      parser.on("error", reject);
      parser.on("end", resolve);
      parser.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    });
    const archive = path.join(staging, "artifact.tar");
    await writeFile(archive, bytes, { mode: 0o600 });
    await extractTar({ file: archive, cwd: target, preservePaths: false, noChmod: true, noMtime: true, strict: true });
  }
}

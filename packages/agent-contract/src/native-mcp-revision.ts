import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Fingerprint the exact configuration inputs, including absent files. */
export function nativeMcpRevision(cwd: string, privateFile: string): string {
  const hash = createHash("sha256");
  for (const file of [path.resolve(cwd, ".mcp.json"), path.resolve(cwd, ".pi/mcp.json"), path.resolve(privateFile)]) {
    const name = Buffer.from(file);
    hash.update(`${name.length}:`).update(name);
    let content: Buffer;
    try {
      content = readFileSync(file);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        hash.update("absent;");
        continue;
      }
      throw new Error("Native MCP configuration could not be read");
    }
    hash.update(`present:${content.length}:`).update(content);
  }
  return hash.digest("hex");
}

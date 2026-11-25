import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Fingerprint the exact configuration inputs, including absent files. */
export function nativeMcpRevision(
  cwd: string,
  privateFile: string,
  read: (file: string) => Buffer | null | undefined = readFileSync,
): string {
  const hash = createHash("sha256");
  for (const file of [path.resolve(cwd, ".mcp.json"), path.resolve(cwd, ".pi/mcp.json"), path.resolve(privateFile)]) {
    const name = Buffer.from(file);
    hash.update(`${name.length}:`).update(name);
    let content: Buffer | null | undefined;
    try {
      content = read(file);
    } catch (error) {
      if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw new Error("Native MCP configuration could not be read");
      }
    }
    if (content === undefined) hash.update("absent;");
    else if (content === null) hash.update("unreadable;");
    else hash.update(`present:${content.length}:`).update(content);
  }
  return hash.digest("hex");
}

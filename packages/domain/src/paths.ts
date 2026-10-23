import path from "node:path";

/** Resolve a path inside `root`. Blank, absolute, and `..` escapes fail closed. */
export function confinedPath(target: string, root: string): string {
  const trimmed = target.trim();
  if (trimmed.length === 0 || trimmed === "/") {
    throw new Error("path must be explicit");
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, trimmed);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`path escapes ${base}`);
  }
  return resolved;
}

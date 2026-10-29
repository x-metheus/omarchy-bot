import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const plugin = "packages/omarchy-plugin";

function sourceFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?|qml|sh|ps1|json|ya?ml)$/.test(file) ? [file] : [];
  });
}

function moduleImports(file: string): string[] {
  const source = readFileSync(path.join(root, file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|#)/.test(line))
    .join("\n");
  const imports = [...source.matchAll(
    /\b(?:import|export)\s+(?:type\s+)?(?:[^;"'`]*?\s+from\s*)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g,
  )].map((match) => match[1] ?? match[2]!);
  if (file.endsWith(".sh")) {
    return [...source.matchAll(/^\s*(?:source|\.)\s+["']?([^\s"';]+)/gm)]
      .map((match) => match[1]!);
  }
  return imports;
}

function repositoryPath(file: string, specifier: string): string {
  return specifier.startsWith(".") || path.isAbsolute(specifier)
    ? path.relative(root, path.resolve(root, path.dirname(file), specifier))
    : specifier;
}

test("production source never imports the Omarchy plugin package", () => {
  const violations: string[] = [];
  for (const directory of ["apps", "packages", "workers", "scripts"]) {
    for (const file of sourceFiles(directory)) {
      if (file.startsWith(`${plugin}/`)) continue;
      for (const specifier of moduleImports(file)) {
        const target = repositoryPath(file, specifier);
        if (specifier.includes("packages/omarchy-plugin")
          || specifier.includes("@omarchy-bot/omarchy-plugin")
          || specifier.includes("plugin/Service.qml")
          || target === plugin || target.startsWith(`${plugin}/`)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }
  }
  expect(violations).toEqual([]);
});

test("the Omarchy plugin never imports Service source or the CLI as a module", () => {
  expect(existsSync(path.join(root, plugin, "package.json"))).toBe(true);
  const violations: string[] = [];
  for (const file of sourceFiles(plugin)) {
    for (const specifier of moduleImports(file)) {
      const target = repositoryPath(file, specifier);
      if (/^@omarchy-bot\/(?!omarchy-plugin(?:\/|$))/.test(specifier)
        || /^(?:apps\/(?:daemon|web|site|sidecar-rust|cli)(?:\/|$)|workers(?:\/|$)|packages\/(?!omarchy-plugin(?:\/|$)))/.test(target)) {
        violations.push(`${file} imports ${specifier}`);
      }
    }
  }
  expect(violations).toEqual([]);
});

test("application packaging uses the Rust Sidecar without a TypeScript runtime", () => {
  const violations: string[] = [];
  if (existsSync(path.join(root, "apps/sidecar"))) violations.push("TypeScript Sidecar source remains");
  const files = ["package.json", "bun.lock", ...["apps", "packages", "workers", "scripts", ".github", "tests"].flatMap(sourceFiles)];
  for (const file of files) {
    if (file === "tests/integration/package-boundaries.test.ts") continue;
    const source = readFileSync(path.join(root, file), "utf8");
    if (/apps\/sidecar(?:\/|["'])|@omarchy-bot\/sidecar(?:["'@/]|$)/m.test(source)
      || /bun\s+build[^\n]*--compile[^\n]*sidecar/i.test(source)) {
      violations.push(`${file} references the TypeScript Sidecar`);
    }
  }
  expect(violations).toEqual([]);
});

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { confinedPath } from "./paths.ts";

const root = path.resolve("/tmp/omarchy-bot/workspace");

describe("confinedPath", () => {
  test("accepts the root itself and paths inside it", () => {
    expect(confinedPath(".", root)).toBe(root);
    expect(confinedPath("skills/demo", root)).toBe(path.join(root, "skills/demo"));
  });

  test("rejects blank and root-only paths", () => {
    expect(() => confinedPath("", root)).toThrow();
    expect(() => confinedPath("   ", root)).toThrow();
    expect(() => confinedPath("/", root)).toThrow();
  });

  test("rejects traversal and absolute escapes", () => {
    expect(() => confinedPath("../../etc/passwd", root)).toThrow();
    expect(() => confinedPath("/etc/passwd", root)).toThrow();
  });

  test("rejects a sibling that shares the root prefix", () => {
    expect(() => confinedPath("../workspace-other/file", root)).toThrow();
  });
});

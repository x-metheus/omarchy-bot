import { expect, test } from "bun:test";
import { displayPath } from "./displayPath.ts";

test("distinguishes a bidi override from literal escape text", () => {
  const escaped = displayPath("/projects/reports/summary\u202Etxt.pdf");
  const literal = displayPath("/projects/reports/summary\\u202etxt.pdf");
  expect(escaped).toBe("escaped: /projects/reports/summary\\u202etxt.pdf");
  expect(literal).toBe("/projects/reports/summary\\u202etxt.pdf");
  expect(escaped).not.toBe(literal);
});

test("doubles literal backslashes in a path that needs escaping", () => {
  expect(displayPath("/tmp/\\u202e/summary\u202Etxt.pdf")).toBe("escaped: /tmp/\\\\u202e/summary\\u202etxt.pdf");
});

test("escapes control and format characters without dropping path characters", () => {
  expect(displayPath("/a\u0000\u001F\u007F\u009F\u061C\u200B\u200F\u202A\u2060\u2065\u206F\uFEFFb")).toBe(
    "escaped: /a\\u0000\\u001f\\u007f\\u009f\\u061c\\u200b\\u200f\\u202a\\u2060\\u2065\\u206f\\ufeffb",
  );
  expect(displayPath("/a\u{E0001}b")).toBe("escaped: /a\\udb40\\udc01b");
});

test("preserves ordinary Unicode paths and literal backslashes", () => {
  const path = "/projects/annual reports/Résumé 日本語.txt";
  expect(displayPath(path)).toBe(path);
  const pathWithBackslashes = "C:\\reports\\summary.txt";
  expect(displayPath(pathWithBackslashes)).toBe(pathWithBackslashes);
});

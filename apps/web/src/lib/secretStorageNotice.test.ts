import { expect, test } from "bun:test";
import { secretStorageNotice } from "./secretStorageNotice.ts";

test("file storage shows the persistent plaintext warning with the platform limits", () => {
  expect(secretStorageNotice({ backend: "file" })).toEqual({
    kind: "banner",
    status: "warning",
    role: "status",
    title: "No OS keychain is available.",
    description: "Secrets are stored in a private plaintext file readable by your user, including commands run by a Bot. Protection from other OS users is enforced on POSIX; it is unverified on Windows. POSIX directory/file permissions are 0700/0600.",
  });
});

test("unavailable storage shows an error with the Service reason", () => {
  expect(secretStorageNotice({ backend: "unavailable", reason: "Unable to verify the OS keychain copy." })).toEqual({
    kind: "banner",
    status: "error",
    role: "alert",
    title: "Unable to access secret storage",
    description: "Unable to verify the OS keychain copy.",
  });
});

test("a failed storage status request shows the generic error even with cached status", () => {
  const expected = {
    kind: "banner",
    status: "error",
    role: "alert",
    title: "Unable to access secret storage",
    description: "The Service could not report secret storage status.",
  } as const;
  expect(secretStorageNotice(undefined, true)).toEqual(expected);
  expect(secretStorageNotice({ backend: "file", reason: "No OS keychain is available." }, true)).toEqual(expected);
  expect(secretStorageNotice({ backend: "unavailable", reason: "The OS keychain is unavailable." }, true)).toEqual(expected);
});

test("keychain storage shows the same-user access note", () => {
  expect(secretStorageNotice({ backend: "keychain" })).toEqual({
    kind: "text",
    text: "Commands run by a Bot as your user may be able to access the keychain.",
  });
});

test("pending storage status shows the checking message", () => {
  expect(secretStorageNotice(undefined)).toEqual({ kind: "text", text: "Checking secret storage…" });
});

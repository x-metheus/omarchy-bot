import { describe, expect, test } from "bun:test";
import { isAbsoluteFolderPath, removableAllowedFolders } from "./allowedFolderPath.ts";

describe("isAbsoluteFolderPath", () => {
  test.each(["/", "/home/user/Shared Workspace", "/tmp/folder ", "C:\\Users\\user", "D:/Downloads", "\\\\server\\share\\folder"])(
    "accepts an absolute folder path %j",
    (folder) => expect(isAbsoluteFolderPath(folder)).toBe(true),
  );

  test.each(["", " ", "relative/folder", "../folder", "~/Downloads", "C:relative", "file:///tmp", "/tmp/invalid\0folder"])(
    "rejects a non-absolute or invalid folder path %j",
    (folder) => expect(isAbsoluteFolderPath(folder)).toBe(false),
  );
});

describe("removableAllowedFolders", () => {
  test("filters implicit folders and keeps the original paths for removal", () => {
    const extra = "/tmp/other/../extra/";
    expect(removableAllowedFolders({
      folders: ["/work/./Shared/", "/home/user/staging/../Downloads", extra, "/work/Shared/subfolder"],
      alwaysAllowed: ["/work/Shared", "/home/user/Downloads"],
    })).toEqual([extra, "/work/Shared/subfolder"]);
  });

  test("returns no removable folders when Windows drive and network paths are implicit", () => {
    expect(removableAllowedFolders({
      folders: ["C:/Users/user/staging/../Downloads/", "\\\\server\\share\\.\\Shared\\"],
      alwaysAllowed: ["C:\\Users\\user\\Downloads", "\\\\server\\share\\Shared"],
    })).toEqual([]);
  });
});

import type { AllowedFoldersDto } from "@omarchy-bot/protocol";

export function isAbsoluteFolderPath(folder: string): boolean {
  if (folder.includes("\0")) return false;
  // The Service can run on a different OS from the browser.
  return folder.startsWith("/") || /^[a-z]:[\\/]/i.test(folder) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(folder);
}

// Resolve absolute paths with the Service's path syntax, independent of the browser OS.
function resolveAbsoluteFolderPath(folder: string): string {
  const drive = /^[a-z]:(?=[\\/])/i.exec(folder)?.[0];
  const share = /^\\\\([^\\/]+)[\\/]+([^\\/]+)/.exec(folder);
  const windowsRoot = drive ?? (share ? `\\\\${share[1]}\\${share[2]}` : undefined);
  const tail = folder.slice(drive?.length ?? share?.[0].length ?? 0);
  const separator = windowsRoot ? "\\" : "/";
  const segments: string[] = [];
  for (const segment of tail.split(windowsRoot ? /[\\/]+/ : "/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return `${windowsRoot ?? ""}${separator}${segments.join(separator)}`;
}

export function removableAllowedFolders({ folders, alwaysAllowed }: AllowedFoldersDto): string[] {
  const implicit = new Set(alwaysAllowed.map(resolveAbsoluteFolderPath));
  return folders.filter((folder) => !implicit.has(resolveAbsoluteFolderPath(folder)));
}

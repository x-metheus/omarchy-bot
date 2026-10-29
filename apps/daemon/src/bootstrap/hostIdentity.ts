import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Shared with the native shell: SHA-256 of `${salt}:${trimmedMachineId}`. */
export function hostIdentity(stateDir: string): { salt: string; digest: string } | null {
  try {
    const override = process.env.OMARCHY_BOT_MACHINE_ID_FILE;
    const files = override === undefined ? ["/etc/machine-id", "/var/lib/dbus/machine-id"] : [override];
    let machineId = "";
    for (const file of files) {
      try { machineId = readFileSync(file, "utf8").trim(); } catch { continue; }
      if (/^[0-9a-f]{32}$/.test(machineId) && machineId !== "0".repeat(32)) break;
      machineId = "";
    }
    if (!machineId) return null;
    const file = path.join(stateDir, "host-identity-salt");
    try {
      writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) return null;
    }
    chmodSync(file, 0o600);
    const salt = readFileSync(file, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(salt)) return null;
    return { salt, digest: createHash("sha256").update(`${salt}:${machineId}`).digest("hex") };
  } catch { return null; }
}

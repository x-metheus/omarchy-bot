import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const bwrap = process.platform === "linux" ? Bun.which("bwrap") : null;

// A private user/mount namespace runs the real entrypoint as root with a read-only host filesystem.
async function session(options: { image?: boolean; container?: boolean; uid?: string; gid?: string; dropFails?: boolean } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "linux-app-session-"));
  try {
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(directory, "image"), "omarchy-bot-linux-app-v1\n");
    writeFileSync(path.join(directory, "container"), "");
    for (const command of ["mktemp", "openssl", "cp", "update-ca-certificates", "chown", "hostname"]) {
      const file = path.join(bin, command);
      writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' '${command}' >> /fixture/mutations\nexit 90\n`);
      chmodSync(file, 0o755);
    }
    writeFileSync(path.join(bin, "setpriv"), `#!/bin/bash\nprintf '%s\\n' "$*" >> /fixture/drop\nexit ${options.dropFails ? 1 : 0}\n`);
    chmodSync(path.join(bin, "setpriv"), 0o755);
    const child = Bun.spawn([
      bwrap!, "--unshare-user", "--uid", "0", "--gid", "0", "--die-with-parent",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      "--symlink", "usr/bin", "/bin", "--dir", "/etc", "--dir", "/run", "--dir", "/tmp",
      "--proc", "/proc", "--dev", "/dev", "--bind", directory, "/fixture", "--ro-bind", root, "/src",
      ...(options.image ? ["--ro-bind", path.join(directory, "image"), "/etc/omarchy-bot-linux-app"] : []),
      ...(options.container ? ["--ro-bind", path.join(directory, "container"), "/.dockerenv"] : []),
      "--", "/bin/bash", "-c", '[[ $(/usr/bin/id -u) == 0 ]] || exit 91; exec /bin/bash /src/scripts/linux-app/session.sh',
    ], {
      env: { PATH: "/fixture/bin:/usr/bin", OMARCHY_BOT_SMOKE_UID: options.uid ?? "1000", OMARCHY_BOT_SMOKE_GID: options.gid ?? "1000" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return {
      code, stdout, stderr,
      mutations: existsSync(path.join(directory, "mutations")) ? readFileSync(path.join(directory, "mutations"), "utf8") : "",
      drop: existsSync(path.join(directory, "drop")) ? readFileSync(path.join(directory, "drop"), "utf8") : "",
    };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const linuxTest = bwrap ? test : test.skip;
linuxTest("Linux app smoke refuses CA trust on a host even as root", async () => {
  const result = await session();
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("repository's Linux app container");
  expect(result.mutations).toBe("");
  expect(result.drop).toBe("");
});

linuxTest.each([
  { image: true },
  { container: true },
])("Linux app smoke needs both image and container evidence: %j", async options => {
  const result = await session(options);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("repository's Linux app container");
  expect(result.mutations).toBe("");
  expect(result.drop).toBe("");
});

linuxTest.each([
  { uid: "0" }, { uid: "" }, { uid: "invalid" },
  { gid: "0" }, { gid: "" }, { gid: "invalid" },
  { dropFails: true },
])("Linux app smoke refuses CA trust before an unusable privilege drop: %j", async options => {
  const result = await session({ image: true, container: true, ...options });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("working non-root smoke UID/GID");
  expect(result.mutations).toBe("");
});

linuxTest("Linux app smoke reaches certificate setup only after container and privilege checks", async () => {
  const result = await session({ image: true, container: true });
  expect(result.drop).toBe("--reuid=1000 --regid=1000 --clear-groups /bin/true\n");
  expect(result.mutations).toBe("mktemp\n");
  expect(result.code).toBe(90);
});

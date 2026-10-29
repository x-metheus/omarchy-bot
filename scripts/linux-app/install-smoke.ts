import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layoutFromEnv } from "../../apps/cli/src/layout.ts";
import { run } from "../../apps/cli/src/main.ts";

const root = process.env.OMARCHY_BOT_INSTALL_SMOKE_DIR!;
assert.ok(root, "Run through install-smoke.sh");
const bin = join(root, "bin");
mkdirSync(bin);
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OMARCHY_BOT_HOME: join(root, "service with spaces"), OMARCHY_BOT_STATE: join(root, "state"), OMARCHY_BOT_PORT: "17438", OMARCHY_BOT_HOST: "127.0.0.1", OMARCHY_BOT_APP_IMAGE: "/artifact/app.AppImage", OMARCHY_BOT_OPEN: "true", OMARCHY_BOT_WORKERS_DIR: "/src/tests/integration/fake-workers" };
const layout = layoutFromEnv(env);
const origin = "http://127.0.0.1:17438";
const checks: string[] = [];
const pass = (label: string) => { checks.push(label); console.log(`PASS ${label}`); };
async function until(label: string, action: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) { try { if (await action()) return; } catch {} await Bun.sleep(150); }
  throw new Error(`Timed out: ${label}`);
}
const pids = () => readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
  try { return readlinkSync(`/proc/${name}/exe`).includes("/.mount_") && readFileSync(`/proc/${name}/environ`, "utf8").includes(`OMARCHY_BOT_INSTALL_SMOKE_DIR=${root}\0`) && readlinkSync(`/proc/${name}/exe`).endsWith("/omarchy-bot") ? [Number(name)] : []; } catch { return []; }
});
async function stopApps() {
  for (const pid of pids()) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await until("app exits", () => pids().length === 0);
}
const managerDir = join(env.XDG_RUNTIME_DIR!, "systemd");
mkdirSync(managerDir, { recursive: true });
const manager = Bun.listen({ unix: join(managerDir, "private"), socket: { data() {} } });
// Only the launcher boundary is a fixture; the installed CLI and running Service are real.
writeFileSync(join(bin, "systemctl"), `#!/bin/sh\ncase " $* " in\n*" enable "*|*" start "*) if [ ! -f '${root}/service.pid' ]; then /usr/local/bin/bun /src/tests/e2e/daemon-boot.ts > '${root}/service.log' 2>&1 & echo $! > '${root}/service.pid'; fi;;\n*" disable "*) kill "$(cat '${root}/service.pid')";;\nesac\nexit 0\n`, { mode: 0o755 });
const serve = "#!/bin/sh\nexec /usr/local/bin/bun /src/tests/e2e/daemon-boot.ts\n";
const archive = join(root, "runtime.tar.zst");
writeFileSync(archive, Bun.zstdCompressSync(await new Bun.Archive({ "scripts/serve.sh": serve }).bytes()));
writeFileSync(`${archive}.sha256`, createHash("sha256").update(readFileSync(archive)).digest("hex"));
const args = ["install", "--archive", archive, "--checksum", `${archive}.sha256`, "--no-browser-pack"];
let launched: Bun.Subprocess | undefined;
try {
  assert.equal(await run(args, env), 0);
  assert.equal(createHash("sha256").update(readFileSync(layout.appImage)).digest("hex"), createHash("sha256").update(readFileSync(env.OMARCHY_BOT_APP_IMAGE)).digest("hex"));
  pass("public CLI installs the checksum-verified real AppImage with private desktop and scheme registration");
  launched = Bun.spawn([layout.appImage], { env, stdout: Bun.file(join(root, "app.log")), stderr: Bun.file(join(root, "app-error.log")) });
  await until("ordinary FUSE AppImage process", () => pids().length > 0);
  const mounted = pids()[0]!;
  assert.ok(readFileSync(`/proc/${mounted}/mountinfo`, "utf8").includes("fuse."), "AppImage must run on FUSE");
  pass("ordinary installed AppImage launches through FUSE without extract-and-run");
  await stopApps();
  await launched.exited;
  writeFileSync(join(bin, "scheme-open"), '#!/bin/sh\nexec gio open "$1"\n', { mode: 0o755 });
  const dispatched = await run(args, { ...env, OMARCHY_BOT_OPEN: "scheme-open" });
  assert.equal(dispatched, 0);
  const secret = readFileSync(layout.hostSecretPath, "utf8").trim();
  const headers = { authorization: `Bearer ${secret}` };
  await until("installed scheme pairs real app to real Service", async () => {
    const response = await fetch(`${origin}/api/devices/paired`, { headers });
    const result = await response.json() as { devices: unknown[] };
    return result.devices.length > 0 && pids().length > 0;
  });
  pass("gio dispatches installed omarchy-bot URL scheme and the FUSE app exchanges pairing with the real Service");
  await until("scheme pairing persists in keychain", () => Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"], { env }).exitCode === 0);
  pass("scheme pairing persists in the private OS keychain");
  await stopApps();
  writeFileSync(join(layout.dataDir, "keep-user-data"), "preserved");
  assert.equal(await run(["uninstall"], env), 0);
  assert.equal(existsSync(layout.appImage), false);
  assert.equal(existsSync(layout.desktopEntry), false);
  assert.ok(!readFileSync(layout.mimeappsPath, "utf8").includes("omarchy-bot.desktop"));
  assert.equal(readFileSync(join(layout.dataDir, "keep-user-data"), "utf8"), "preserved");
  pass("uninstall removes managed app and scheme and preserves user data");
} catch (error) {
  for (const file of ["app-error.log", "service.log"]) { try { console.error(`${file}: ${readFileSync(join(root, file), "utf8")}`); } catch {} }
  throw error;
} finally {
  await stopApps().catch(() => {});
  try { process.kill(Number(readFileSync(join(root, "service.pid"), "utf8")), "SIGTERM"); } catch {}
  manager.stop(true);
  writeFileSync(".lane/linux-app/evidence/install-results.json", JSON.stringify({ checks }, null, 2));
}

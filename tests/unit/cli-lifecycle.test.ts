import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutFromEnv } from "../../apps/cli/src/layout.ts";
import { doctorText, installUnit, renderUnit, startUnit, statusText, stopUnit, uninstall, userManagerAvailable } from "../../apps/cli/src/lifecycle.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "omarchy-bot-cli-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    USER: "fixture-user",
    XDG_RUNTIME_DIR: join(home, "run"),
    OMARCHY_BOT_PORT: "17421",
  };
  return { home, bin, env, layout: layoutFromEnv(env) };
}

function shim(bin: string, name: string, script: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function managerSocket(env: NodeJS.ProcessEnv) {
  const directory = join(env.XDG_RUNTIME_DIR!, "systemd");
  mkdirSync(directory, { recursive: true });
  const server = Bun.listen({
    unix: join(directory, "private"),
    socket: { data() {} },
  });
  cleanups.push(() => server.stop(true));
}

describe("CLI user service lifecycle", () => {
  test("renders concrete fixture paths and the required service policy", () => {
    const { home, env, layout } = fixture();
    expect(layout.dataDir).toBe(join(home, ".local/share/omarchy-bot"));
    expect(layout.stateDir).toBe(join(home, ".local/state/omarchy-bot"));
    const unit = renderUnit(layout);
    for (const line of [
      `ExecStart=${layout.servePath}`,
      `WorkingDirectory=${layout.currentDir}`,
      "Restart=on-failure",
      "RestartSec=3",
      "KillMode=control-group",
      "NoNewPrivileges=true",
      `StandardOutput=append:${layout.serviceLog}`,
      `StandardError=append:${layout.serviceLog}`,
      "WantedBy=default.target",
      `HOME=${home}`,
      `OMARCHY_BOT_HOME=${layout.dataDir}`,
      `OMARCHY_BOT_STATE=${layout.stateDir}`,
      "OMARCHY_BOT_HOST=127.0.0.1",
      "OMARCHY_BOT_PORT=17421",
      `PATH=${env.PATH}`,
      `XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR}`,
    ]) expect(unit).toContain(line);
    expect(unit).not.toContain("notify-send");
    expect(unit).not.toContain("%h");
  });

  test("installs and controls the service only through the fixture user manager", async () => {
    const { home, bin, env, layout } = fixture();
    const calls = join(home, "systemctl-calls");
    env.CALLS = calls;
    shim(bin, "systemctl", 'printf "%s\\n" "$*" >> "$CALLS"');
    expect(userManagerAvailable(env)).toBe(false);
    await expect(installUnit(layout, env)).rejects.toThrow(/user systemd manager/);
    expect(existsSync(calls)).toBe(false);
    managerSocket(env);
    expect(userManagerAvailable(env)).toBe(true);
    await installUnit(layout, env);
    expect(readFileSync(layout.unitPath, "utf8")).toBe(renderUnit(layout));
    expect(statSync(layout.unitPath).mode & 0o777).toBe(0o644);
    expect(statSync(layout.unitDir).mode & 0o777).toBe(0o755);
    expect(statSync(layout.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(layout.serviceLog).mode & 0o777).toBe(0o600);
    await startUnit(layout, env);
    await stopUnit(layout, env);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      "--user daemon-reload",
      "--user enable --now omarchy-bot.service",
      "--user start omarchy-bot.service",
      "--user stop omarchy-bot.service",
    ]);
  });

  test("reports failed startup with the last non-empty service log line", async () => {
    const { bin, env, layout } = fixture();
    shim(bin, "systemctl", 'test "$1" = --user || exit 99\nif [ "$2" = is-active ]; then printf "failed\\n"; exit 3; fi\nexit 99');
    mkdirSync(layout.stateDir, { recursive: true });
    writeFileSync(layout.serviceLog, "listening\nError: boom\nat main (main.ts:1:1)\nomarchy-bot daemon stopped\n");
    const status = await statusText(layout, env);
    expect(status).toContain("state: failed");
    expect(status).toContain("address: http://127.0.0.1:17421");
    expect(status).toContain("startup failure: at main (main.ts:1:1)");
    shim(bin, "systemctl", 'printf "active\\n"');
    writeFileSync(layout.serviceLog, "listening\n");
    expect(await statusText(layout, env)).not.toContain("startup failure");
  });

  test("diagnoses missing prerequisites and accepts a complete lingering user manager", async () => {
    const { bin, env } = fixture();
    const minimalEnv = { ...env, PATH: bin };
    shim(bin, "uname", 'if [ "$1" = -s ]; then printf "Linux\\n"; else printf "arm64\\n"; fi');
    const missing = await doctorText(minimalEnv);
    for (const message of ["missing: bun", "missing: bash", "missing: flock", "missing: systemctl", "missing: x86_64", "missing: user systemd manager", "missing: loginctl"]) {
      expect(missing).toContain(message);
    }
    expect(missing).not.toContain("loginctl enable-linger");
    shim(bin, "bash", "exit 0");
    shim(bin, "bun", 'test "$1" = --version || exit 99\nprintf "1.4.2\\n"');
    shim(bin, "flock", "exit 0");
    shim(bin, "systemctl", "exit 0");
    shim(bin, "uname", 'if [ "$1" = -s ]; then printf "Linux\\n"; else printf "x86_64\\n"; fi');
    shim(bin, "loginctl", 'test "$*" = "show-user fixture-user -p Linger" || exit 99\nprintf "Linger=yes\\n"');
    managerSocket(env);
    const healthy = await doctorText(minimalEnv);
    expect(healthy).not.toContain("enable-linger");
    expect(healthy).not.toContain("missing:");
    shim(bin, "bun", 'printf "1.3.9\\n"');
    expect(await doctorText(minimalEnv)).toContain("missing: bun");
    shim(bin, "loginctl", "exit 1");
    expect(await doctorText(minimalEnv)).not.toContain("loginctl enable-linger");
    shim(bin, "loginctl", 'printf "Linger=no\\n"');
    expect(await doctorText(minimalEnv)).toContain("loginctl enable-linger");
  });

  test("uninstalls runtime and the unit while preserving user data despite manager failure", async () => {
    const { home, bin, env, layout } = fixture();
    env.CALLS = join(home, "uninstall-calls");
    shim(bin, "systemctl", 'printf "%s\\n" "$*" >> "$CALLS"\nexit 1');
    const userFiles: [string, string][] = [
      [layout.dbPath, "bots"],
      [join(layout.screensDir, "profile"), "screen"],
      [join(layout.workspaceDir, "note"), "ws"],
      [layout.serviceLog, "keep logs"],
      [layout.hostSecretPath, "keep secret"],
    ];
    for (const [path, contents] of userFiles) {
      mkdirSync(join(path!, ".."), { recursive: true });
      writeFileSync(path!, contents!);
    }
    mkdirSync(join(layout.currentDir, "scripts"), { recursive: true });
    writeFileSync(layout.servePath, "#!/bin/sh\n");
    mkdirSync(layout.unitDir, { recursive: true });
    writeFileSync(layout.unitPath, renderUnit(layout));
    await uninstall(layout, env);
    for (const [path, contents] of userFiles) expect(readFileSync(path!, "utf8")).toBe(contents);
    expect(existsSync(layout.unitPath)).toBe(false);
    expect(existsSync(layout.runtimeDir)).toBe(false);
    expect(readFileSync(env.CALLS, "utf8").trim().split("\n")).toEqual([
      "--user disable --now omarchy-bot.service",
      "--user daemon-reload",
    ]);
  });
});

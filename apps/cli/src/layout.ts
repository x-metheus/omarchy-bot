import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Layout {
  home: string;
  dataDir: string;
  stateDir: string;
  runtimeDir: string;
  currentDir: string;
  browserPackDir: string;
  servePath: string;
  unitDir: string;
  unitPath: string;
  serviceLog: string;
  dbPath: string;
  screensDir: string;
  workspaceDir: string;
  hostSecretPath: string;
  host: string;
  port: string;
  env: NodeJS.ProcessEnv;
}

export function layoutFromEnv(env: NodeJS.ProcessEnv = process.env): Layout {
  const home = resolve(env.HOME || homedir());
  const dataDir = resolve(env.OMARCHY_BOT_HOME || join(home, ".local/share/omarchy-bot"));
  const stateDir = resolve(env.OMARCHY_BOT_STATE || join(home, ".local/state/omarchy-bot"));
  const runtimeDir = join(dataDir, "runtime");
  const currentDir = join(runtimeDir, "current");
  const unitDir = join(resolve(env.XDG_CONFIG_HOME || join(home, ".config")), "systemd/user");
  return {
    home,
    dataDir,
    stateDir,
    runtimeDir,
    currentDir,
    browserPackDir: join(runtimeDir, "browser"),
    servePath: join(currentDir, "scripts/serve.sh"),
    unitDir,
    unitPath: join(unitDir, "omarchy-bot.service"),
    serviceLog: join(stateDir, "service.log"),
    dbPath: join(dataDir, "db.sqlite"),
    screensDir: join(dataDir, "screens"),
    workspaceDir: join(home, ".omarchy-bot/workspace"),
    hostSecretPath: join(stateDir, "pairing-host-secret"),
    host: env.OMARCHY_BOT_HOST || "127.0.0.1",
    port: env.OMARCHY_BOT_PORT || "7321",
    env: { ...env },
  };
}

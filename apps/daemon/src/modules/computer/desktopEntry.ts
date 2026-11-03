import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Read only the main desktop group; action groups cannot override its launch command. */
export function parseDesktopEntry(source: string): Map<string, string> {
  const keys = new Map<string, string>();
  let group = "";
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*\[.*\]\s*$/.test(line)) group = line.trim();
    const setting = /^\s*([^#=]+?)\s*=\s*(.*?)\s*$/.exec(line);
    if (group === "[Desktop Entry]" && setting) keys.set(setting[1]!, setting[2]!);
  }
  return keys;
}

function parseDesktopExec(value: string): string[] {
  const argv: string[] = [];
  let argument = "";
  let quoted = false;
  let escaped = false;
  const finishArgument = (): void => {
    if (argument !== "") argv.push(argument);
    argument = "";
  };
  for (const character of value.trim()) {
    if (escaped) {
      argument += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "\"") {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(character)) {
      finishArgument();
    } else {
      argument += character;
    }
  }
  if (escaped || quoted) throw new Error("application desktop entry has an invalid Exec command");
  finishArgument();
  return argv
    .filter((entry) => !/^%[fFuUick]$/.test(entry))
    .map((entry) => entry.replaceAll("%%", "%"));
}

/**
 * The argv an `open_app` request runs: a desktop id resolves through the Bot
 * Computer's data directories (its own `XDG_DATA_HOME` first), anything else is
 * the command itself.
 */
export function desktopApplicationCommand(
  application: string,
  environment: Record<string, string>,
): string[] {
  if (!application.endsWith(".desktop")) return [application];
  const dataHomes = [
    environment.XDG_DATA_HOME ?? path.join(environment.HOME ?? "", ".local", "share"),
    ...(environment.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":"),
  ];
  const entryPath = dataHomes
    .map((directory) => path.join(directory, "applications", application))
    .find((candidate) => existsSync(candidate));
  if (entryPath === undefined) throw new Error(`application desktop entry not found: ${application}`);
  const keys = parseDesktopEntry(readFileSync(entryPath, "utf8"));
  const type = keys.get("Type");
  const exec = keys.get("Exec");
  if (type !== "Application" || exec === undefined) {
    throw new Error(`invalid application desktop entry: ${application}`);
  }
  const argv = parseDesktopExec(exec);
  if (argv.length === 0) throw new Error(`application desktop entry has no executable: ${application}`);
  return argv;
}

/**
 * The executable a desktop `Exec` runs after any `env [--] NAME=value…`
 * wrapper. Env options are skipped too, so a wrapped command is still seen.
 */
export function desktopExecutable(argv: readonly string[]): string | undefined {
  let index = 0;
  while (path.basename(argv[index] ?? "") === "env") {
    index += 1;
    while (index < argv.length && (argv[index]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index]!))) {
      index += 1;
    }
  }
  return argv[index];
}

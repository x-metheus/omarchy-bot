import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseDesktopEntry } from "./desktopEntry.ts";

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

function desktopApplicationCommand(
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
const BROWSER_DESKTOP_ENTRIES = [
  "brave-browser.desktop",
  "google-chrome.desktop",
  "chromium.desktop",
  "firefox.desktop",
];
const BROWSER_BINARIES = ["brave", "google-chrome", "chromium", "firefox"];
/**
 * Snap confinement needs the real home and runtime directory the Bot Computer
 * never shares, so a snap browser can only fail there. Detect it from the path,
 * the resolved symlink, or a small Ubuntu wrapper script, never by executing it.
 */
function snapConfined(candidate: string): boolean {
  const paths = [candidate];
  try {
    paths.push(realpathSync(candidate));
  } catch {
    // An unresolvable path cannot be a snap target.
  }
  if (paths.some((entry) =>
    entry.startsWith("/snap/")
    || entry.startsWith("/var/lib/snapd/")
    || path.basename(entry) === "snap"
  )) {
    return true;
  }
  try {
    if (statSync(candidate).size > 8_192) return false;
    const text = readFileSync(candidate, "utf8");
    if (!text.startsWith("#!")) return false;
    // Ubuntu wraps snap-backed browsers in a tiny script. Match a snap-target
    // command word so unrelated flags or comments do not count.
    return text.split("\n").some((line) => {
      const command = line.trim();
      if (command === "" || command.startsWith("#")) return false;
      return command.split(/\s+/).some((token, index) => {
        if (index > 2) return false;
        const word = token.replace(/^["']|["']$/g, "");
        return path.basename(word) === "snap"
          || word.startsWith("/snap/")
          || word.startsWith("/var/lib/snapd/");
      });
    });
  } catch {
    return false;
  }
}

/** Desktop entries routinely prefix the real command with `env VAR=value …`. */
const ENV_WRAPPER = "env";

type EnvWrapper =
  | { kind: "not-env" }
  | { kind: "unsupported" }
  | { kind: "command"; command: string };

/**
 * Only `env [--] NAME=value… command` is understood. Env *options* (`-S`,
 * `--split-string=`, `-i`, …) and a `PATH` assignment both change which binary
 * env would actually execute, so an entry using them is unsupported rather than
 * classified from argv[0]. Guessing there would launch a snap-confined browser.
 */
function envWrapper(argv: readonly string[]): EnvWrapper {
  let tokens = [...argv];
  let wrapped = false;
  while (path.basename(tokens[0] ?? "") === ENV_WRAPPER) {
    wrapped = true;
    let index = 1;
    if (tokens[index] === "--") index += 1;
    let command: string | undefined;
    for (; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token);
      if (assignment === null) {
        if (token.startsWith("-")) return { kind: "unsupported" };
        command = token;
        break;
      }
      if (assignment[1] === "PATH") return { kind: "unsupported" };
    }
    if (command === undefined) return { kind: "unsupported" };
    tokens = tokens.slice(index);
  }
  return wrapped ? { kind: "command", command: tokens[0]! } : { kind: "not-env" };
}

/** Chromium and Firefox families open a routable new window with `--new-window`. */
const ROUTABLE_BROWSER_BASENAMES = /^(brave|brave-browser|google-chrome|chromium|chrome|firefox)(-[a-z0-9-]+)?$/;

function isExecutableFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile() && (statSync(candidate).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** The installed native browser command line, without a URL argument. */
export function nativeBrowserCommand(
  environment: Record<string, string>,
): { argv: string[]; routable: boolean } | undefined {
  const searchPath = environment.PATH;
  const which = (name: string): string | null =>
    searchPath === undefined ? Bun.which(name) : Bun.which(name, { PATH: searchPath });
  const runnable = (candidate: string): string | undefined => {
    const resolved = candidate.includes("/") ? candidate : which(candidate);
    if (resolved === null || !isExecutableFile(resolved)) return undefined;
    return resolved;
  };
  for (const desktopEntry of BROWSER_DESKTOP_ENTRIES) {
    try {
      const argv = desktopApplicationCommand(desktopEntry, environment);
      // `env NAME=value browser` is a legitimate native launch, so classify the
      // command env would run. Anything env does beyond plain assignments is
      // unsupported: fall through and let the portable browser handle the URL.
      const wrapper = envWrapper(argv);
      if (wrapper.kind === "unsupported") continue;
      const target = runnable(wrapper.kind === "command" ? wrapper.command : argv[0]!);
      if (target !== undefined && !snapConfined(target)) {
        return {
          argv,
          routable: ROUTABLE_BROWSER_BASENAMES.test(path.basename(target)),
        };
      }
    } catch {
      // Try the next installed browser.
    }
  }
  for (const binary of BROWSER_BINARIES) {
    const resolved = runnable(binary);
    if (resolved !== undefined && !snapConfined(resolved)) return { argv: [resolved], routable: true };
  }
  return undefined;
}

export { desktopApplicationCommand };

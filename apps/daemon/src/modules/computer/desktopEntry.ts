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

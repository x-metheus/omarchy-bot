export function displayPath(path: string): string {
  let needsEscaping = false;
  const escaped = path.replace(/[\\\p{Cc}\p{Cf}\u2060-\u206F]/gu, (character) => {
    if (character === "\\") return "\\\\";
    needsEscaping = true;
    // Supplementary format characters use two UTF-16 escapes.
    return character.split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
  });
  return needsEscaping ? `escaped: ${escaped}` : path;
}

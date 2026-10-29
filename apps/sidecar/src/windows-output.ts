// Bun 1.4.4 provides XML; the repository's older Bun declarations do not include it yet.
const runtime = Bun as unknown as { XML: { parse(text: string): unknown } };
const xml = runtime.XML;

/** Decode only PowerShell's framed diagnostic serialization, preserving ordinary stderr. */
export function decodePowerShellDiagnostics(text: string): string {
  return text.replace(/^#< CLIXML\r?\n(<Objs\b[\s\S]*?<\/Objs>)/gm, (framed, document: string) => {
    try {
      const parsed = xml.parse(document);
      if (parsed === null || typeof parsed !== "object" || !("Objs" in parsed)) return framed;
      const root = parsed.Objs;
      if (root === null || typeof root !== "object" || !("@xmlns" in root) || root["@xmlns"] !== "http://schemas.microsoft.com/powershell/2004/04") return framed;
      if (Object.keys(root).some(key => !["@Version", "@xmlns", "Obj", "S"].includes(key))) return framed;
      const objectValue = "Obj" in root ? root.Obj : undefined;
      const objects = objectValue === undefined ? [] : Array.isArray(objectValue) ? objectValue : [objectValue];
      if (objects.some(record => record === null || typeof record !== "object" || !("@S" in record) || record["@S"] !== "progress")) return framed;
      const stringValue = "S" in root ? root.S : undefined;
      const records: unknown[] = stringValue === undefined ? [] : Array.isArray(stringValue) ? stringValue : [stringValue];
      let output = "";
      for (const record of records) {
        if (record === null || typeof record !== "object" || !("@S" in record) || !["warning", "error", "verbose", "debug", "information"].includes(String(record["@S"]).toLowerCase())) return framed;
        if (Object.keys(record).some(key => key !== "@S" && key !== "#text")) return framed;
        const encoded = "#text" in record ? record["#text"] : "";
        if (typeof encoded !== "string") return framed;
        // One replacement pass preserves encoded literal escape sequences such as _x005F_x000D_.
        const value = encoded.replace(/_x([0-9a-f]{4})_/gi, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        output += value + (value.endsWith("\n") ? "" : "\n");
      }
      return output;
    } catch {
      return framed;
    }
  });
}

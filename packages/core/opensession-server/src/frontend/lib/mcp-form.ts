/** Parse the Connections form's env textarea (one `KEY=VALUE` per line). */
export function parseMcpEnvironment(source: string) {
  const entries: Array<[string, string]> = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      throw new Error(`Env line "${trimmed}" must be KEY=VALUE`);
    }
    entries.push([
      trimmed.slice(0, separator).trim(),
      trimmed.slice(separator + 1).trim(),
    ]);
  }
  return Object.fromEntries(entries);
}

export interface McpHeaderRow {
  name: string;
  value: string;
}

/** Build the headers object from the editor's rows, skipping blank rows. */
export function parseMcpHeaderRows(rows: ReadonlyArray<McpHeaderRow>) {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name && !value) continue;
    if (!name) throw new Error("Header name is required");
    if (!value) throw new Error(`Header "${name}" needs a value`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate header "${name}"`);
    seen.add(key);
    headers[name] = value;
  }
  return headers;
}

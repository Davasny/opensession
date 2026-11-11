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

/** A header/env row in the edit dialog. `saved` marks a value that already
 *  exists on the server: the API never sends it back, so a blank value keeps
 *  the stored one instead of clearing it. */
export interface McpEditRow extends McpHeaderRow {
  saved?: boolean;
}

/** A name/value pair for the update API. `null` keeps the stored value. */
export interface McpValueUpdate {
  name: string;
  value: string | null;
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

/**
 * Build the header list for an edit. Saved rows with a blank value become
 * `null` (keep what is stored); a new row still needs a value.
 */
export function parseMcpHeaderUpdates(
  rows: ReadonlyArray<McpEditRow>,
): McpValueUpdate[] {
  const updates: McpValueUpdate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name) {
      if (value) throw new Error("Header name is required");
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate header "${name}"`);
    seen.add(key);
    if (!value && !row.saved) throw new Error(`Header "${name}" needs a value`);
    updates.push({ name, value: value || null });
  }
  return updates;
}

/**
 * Build the env list for an edit. A blank saved row keeps its stored value; a
 * blank new row is a real empty value (the `KEY=` form that means "take this
 * from the process environment").
 */
export function parseMcpEnvironmentUpdates(
  rows: ReadonlyArray<McpEditRow>,
): McpValueUpdate[] {
  const updates: McpValueUpdate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name) {
      if (value) throw new Error("Env variable name is required");
      continue;
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate env variable "${name}"`);
    }
    seen.add(name);
    updates.push({ name, value: row.saved ? value || null : value });
  }
  return updates;
}

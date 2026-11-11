/** Parse the Connections form's `NAME=VALUE` textareas (env and headers). */
function parseKeyValueLines(
  source: string,
  label: "Env" | "Header",
  keyLabel: "KEY" | "NAME",
) {
  const entries: Array<[string, string]> = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      throw new Error(`${label} line "${trimmed}" must be ${keyLabel}=VALUE`);
    }
    entries.push([
      trimmed.slice(0, separator).trim(),
      trimmed.slice(separator + 1).trim(),
    ]);
  }
  return Object.fromEntries(entries);
}

export function parseMcpEnvironment(source: string) {
  return parseKeyValueLines(source, "Env", "KEY");
}

export function parseMcpHeaders(source: string) {
  return parseKeyValueLines(source, "Header", "NAME");
}

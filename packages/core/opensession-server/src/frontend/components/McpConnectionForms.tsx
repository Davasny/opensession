import { useEffect, useRef, useState, type ReactNode } from "react";
import { displayName } from "../brand-logos";
import { request } from "../lib/api/request";
import { errorMessage } from "../lib/error-message";
import {
  parseMcpEnvironment,
  parseMcpEnvironmentUpdates,
  parseMcpHeaderRows,
  parseMcpHeaderUpdates,
  type McpEditRow,
} from "../lib/mcp-form";
import {
  TOKEN_CONNECT_URLS,
  type McpConnection,
  type McpServerUpdateInput,
} from "../lib/mcp-connections";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Field } from "../ui/input";
import { Modal } from "../ui/modal";
import { OptionSelect } from "../ui/select";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { InlineAlert } from "../ui/state";
import { IconPlus, IconX } from "./icons";
import {
  SettingsField,
  SettingsForm,
  SettingsFormActions,
  SettingsFormRow,
  SettingsFormTitle,
  settingsInputClass,
} from "../ui/settings";

/**
 * Paste-a-token connect for providers whose hosted MCP gates OAuth client
 * registration (Vercel approves only clients it has reviewed). Any teammate
 * can mint a personal token; the server validates it live against the
 * provider's API before storing it as a grant.
 */
export function ConnectTokenDialog({
  server,
  onClose,
  onConnected,
}: {
  server: McpConnection | null;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [scope, setScope] = useState<"shared" | "me">("shared");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (server) {
      setScope("shared");
      setToken("");
      setError(null);
    }
  }, [server]);
  if (!server) return null;
  const active = server;
  const tokenPage = TOKEN_CONNECT_URLS[active.name];

  async function connect() {
    if (!token.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await request(
        `/connections/mcp/${encodeURIComponent(active.name)}/token`,
        {
          method: "POST",
          body: { token: token.trim(), scope },
          label: `Could not connect ${active.name}`,
        },
      );
      onConnected();
    } catch (cause) {
      setError(errorMessage(cause, `Could not connect ${active.name}`));
    }
    setSaving(false);
  }

  return (
    <Modal.Root
      open={!!server}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <Modal.Content widthClassName="max-w-[30rem]">
        <Modal.Header
          title={`Connect ${displayName(server.name)} with an API token`}
          description="The token is checked with the provider, then stored for agent runs."
        />
        <div className="flex flex-col gap-4">
          {tokenPage ? (
            <div className="text-supporting leading-snug text-dim">
              Create a token at{" "}
              <a
                className="underline hover:text-fg"
                href={tokenPage.url}
                target="_blank"
                rel="noreferrer"
              >
                {tokenPage.label}
              </a>
              , then paste it here.
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <span className="text-supporting text-dim">Connect as</span>
            <Segmented
              label="Connect as"
              size="sm"
              value={scope}
              onValueChange={(next) => {
                if (next === "shared" || next === "me") setScope(next);
              }}
            >
              <SegmentedOption value="shared">Workspace</SegmentedOption>
              <SegmentedOption value="me">My account</SegmentedOption>
            </Segmented>
          </div>
          <input
            type="password"
            className={cn(settingsInputClass, "font-mono")}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste API token"
            autoComplete="off"
            spellCheck={false}
            aria-label="API token"
          />
          {error && <InlineAlert>{error}</InlineAlert>}
          <Modal.Footer>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!token.trim() || saving}
              onClick={() => void connect()}
            >
              {saving ? "Checking" : "Connect"}
            </Button>
          </Modal.Footer>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * The key/value editor shared by the add form and the edit dialog: one row per
 * header or environment variable, with the name fixed for values already saved
 * (the API never sends them back) and a blank value meaning "keep it".
 */
function McpKeyValueRows({
  label,
  hint,
  addLabel,
  itemNoun,
  namePlaceholder,
  valuePlaceholder,
  savedValuePlaceholder,
  rows,
  onChange,
}: {
  label: string;
  hint: ReactNode;
  addLabel: string;
  itemNoun: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  savedValuePlaceholder: string;
  rows: McpEditRow[];
  onChange: (rows: McpEditRow[]) => void;
}) {
  function updateRow(index: number, field: "name" | "value", value: string) {
    onChange(
      rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [field]: value } : row,
      ),
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-label font-medium text-dim">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          icon={<IconPlus size={14} />}
          className="phone:min-h-11"
          onClick={() => onChange([...rows, { name: "", value: "" }])}
        >
          {addLabel}
        </Button>
      </div>
      <div className="text-meta leading-snug text-faint">{hint}</div>
      {rows.length > 0 && (
        <div className="flex flex-col gap-3 phone:gap-4">
          {rows.map((row, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2 phone:grid-cols-[minmax(0,1fr)_auto]"
            >
              {row.saved ? (
                <span
                  className="flex min-h-8 items-center truncate rounded-control border border-line bg-surface px-2.5 font-mono text-sm text-dim phone:min-h-11 phone:text-input-phone"
                  title={row.name}
                >
                  {row.name}
                </span>
              ) : (
                <input
                  className={cn(
                    settingsInputClass,
                    "min-w-0 font-mono phone:min-h-11 phone:text-input-phone",
                  )}
                  value={row.name}
                  onChange={(e) => updateRow(index, "name", e.target.value)}
                  placeholder={namePlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${itemNoun} ${index + 1} name`}
                />
              )}
              <input
                className={cn(
                  settingsInputClass,
                  "min-w-0 font-mono phone:col-span-2 phone:row-start-2 phone:min-h-11 phone:text-input-phone",
                )}
                value={row.value}
                onChange={(e) => updateRow(index, "value", e.target.value)}
                placeholder={
                  row.saved ? savedValuePlaceholder : valuePlaceholder
                }
                autoComplete="off"
                spellCheck={false}
                aria-label={
                  row.saved
                    ? `${row.name} value`
                    : `${itemNoun} ${index + 1} value`
                }
              />
              <Button
                variant="ghost"
                size="sm"
                icon={<IconX size={16} />}
                className="shrink-0 phone:col-start-2 phone:row-start-1 phone:size-11"
                onClick={() =>
                  onChange(rows.filter((_, rowIndex) => rowIndex !== index))
                }
                aria-label={
                  row.saved
                    ? `Remove ${row.name}`
                    : `Remove ${itemNoun.toLowerCase()} ${index + 1}`
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AddMcpForm({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [headerRows, setHeaderRows] = useState<McpEditRow[]>([
    { name: "", value: "" },
  ]);
  const [allowedUsers, setAllowedUsers] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const envValues = parseMcpEnvironment(env);
      const headerValues = parseMcpHeaderRows(headerRows);
      const allowed = allowedUsers
        .split(",")
        .map((user) => user.trim())
        .filter(Boolean);
      await request("/connections/mcp", {
        method: "POST",
        body: {
          name,
          transport,
          url: transport === "http" ? url.trim() : undefined,
          command: transport === "stdio" ? command.trim() : undefined,
          args:
            transport === "stdio"
              ? args.split(/\s+/).filter(Boolean)
              : undefined,
          env: transport === "stdio" ? envValues : undefined,
          headers: transport === "http" ? headerValues : undefined,
          allowedUsers: allowed.length ? allowed : undefined,
        },
        label: "Could not add MCP server",
      });
      onAdded();
    } catch (cause) {
      setError(errorMessage(cause, "Could not add MCP server"));
      setSaving(false);
    }
  }

  const valid =
    name.trim() && (transport === "http" ? url.trim() : command.trim());

  return (
    <SettingsForm className="mb-[18px] flex flex-col gap-3.5">
      <SettingsFormTitle>Add MCP server</SettingsFormTitle>

      <SettingsFormRow>
        <SettingsField>
          Name
          <input
            className={settingsInputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="github"
          />
        </SettingsField>
        <SettingsField>
          Transport
          <OptionSelect
            label="Transport"
            value={transport}
            options={[
              { value: "http", label: "http · remote MCP endpoint" },
              { value: "stdio", label: "stdio · local command" },
            ]}
            onChange={(next) => {
              if (next === "http" || next === "stdio") setTransport(next);
            }}
          />
        </SettingsField>
      </SettingsFormRow>

      {transport === "http" ? (
        <>
          <SettingsField>
            URL
            <input
              className={settingsInputClass}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.com/mcp"
            />
          </SettingsField>
          <McpKeyValueRows
            label="Headers"
            hint="Sent with every request. Stored in mcp-config.json."
            addLabel="Add header"
            itemNoun="Header"
            namePlaceholder="Authorization"
            valuePlaceholder="Bearer <api-key>"
            savedValuePlaceholder="Leave blank to keep"
            rows={headerRows}
            onChange={setHeaderRows}
          />
        </>
      ) : (
        <>
          <SettingsFormRow>
            <SettingsField>
              Command
              <input
                className={settingsInputClass}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="~/bin/my-mcp"
              />
            </SettingsField>
            <SettingsField>
              Args (space-separated)
              <input
                className={settingsInputClass}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="run /path/to/server.ts"
              />
            </SettingsField>
          </SettingsFormRow>
          <SettingsField>
            Env (KEY=VALUE, one per line, stored in mcp-config.json)
            <textarea
              className={cn(settingsInputClass, "resize-y font-mono")}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={2}
              placeholder={"API_KEY=${MY_API_KEY}"}
            />
          </SettingsField>
        </>
      )}

      <SettingsField>
        Allowed users (optional, comma-separated, blank for everyone)
        <input
          className={settingsInputClass}
          value={allowedUsers}
          onChange={(e) => setAllowedUsers(e.target.value)}
          placeholder="Alice, Bob"
        />
      </SettingsField>

      {error && <InlineAlert>{error}</InlineAlert>}

      <SettingsFormActions>
        <Button variant="soft" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleAdd}
          disabled={saving || !valid}
        >
          {saving ? "Adding…" : "Add server"}
        </Button>
      </SettingsFormActions>
    </SettingsForm>
  );
}

/**
 * Edit a configured server without re-entering credentials it already has:
 * secret values are never sent to the browser, so a saved header or env
 * variable stays as it is unless its value is replaced. The name and transport
 * are fixed; switching either is a remove and a re-add.
 */
export function EditMcpDialog({
  server,
  onClose,
  onSaved,
}: {
  server: McpConnection;
  onClose: () => void;
  onSaved: () => void;
}) {
  const http = server.transport === "http";
  const initialUrl = server.url ?? server.target;
  const [url, setUrl] = useState(initialUrl);
  const [command, setCommand] = useState(server.command ?? "");
  const [args, setArgs] = useState((server.args ?? []).join(" "));
  const [headerRows, setHeaderRows] = useState<McpEditRow[]>(() =>
    (server.headerNames ?? []).map((name) => ({
      name,
      value: "",
      saved: true,
    })),
  );
  const [envRows, setEnvRows] = useState<McpEditRow[]>(() =>
    (server.envKeys ?? []).map((name) => ({ name, value: "", saved: true })),
  );
  const [allowedUsers, setAllowedUsers] = useState(
    (server.allowedUsers ?? []).join(", "),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: McpServerUpdateInput = {
        allowedUsers: allowedUsers
          .split(",")
          .map((user) => user.trim())
          .filter(Boolean),
      };
      if (http) {
        const nextUrl = url.trim();
        if (nextUrl !== initialUrl.trim()) body.url = nextUrl;
        body.headers = parseMcpHeaderUpdates(headerRows);
      } else {
        const nextCommand = command.trim();
        if (nextCommand !== (server.command ?? "").trim()) {
          body.command = nextCommand;
        }
        const nextArgs = args.split(/\s+/).filter(Boolean);
        if (JSON.stringify(nextArgs) !== JSON.stringify(server.args ?? [])) {
          body.args = nextArgs;
        }
        body.env = parseMcpEnvironmentUpdates(envRows);
      }
      await request(`/connections/mcp/${encodeURIComponent(server.name)}`, {
        method: "PUT",
        body,
        label: `Could not update ${server.name}`,
      });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, `Could not update ${server.name}`));
      setSaving(false);
    }
  }

  const valid = http ? !!url.trim() : !!command.trim();
  const hasSavedHeaders = headerRows.some((row) => row.saved);
  const hasSavedEnv = envRows.some((row) => row.saved);

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <Modal.Content
        widthClassName="max-w-[34rem]"
        initialFocus={firstFieldRef}
      >
        <Modal.Header
          title={`Edit ${displayName(server.name)}`}
          description={
            http
              ? "Remote endpoint. Stored credentials stay unless you replace them."
              : "Local command. Stored environment values stay unless you replace them."
          }
        />
        <div className="flex flex-col gap-4">
          {http ? (
            <>
              <Field label="URL">
                <input
                  ref={firstFieldRef}
                  className={cn(
                    settingsInputClass,
                    "phone:min-h-11 phone:text-input-phone",
                  )}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://api.example.com/mcp"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              {server.urlHasQuery && (
                <div className="-mt-2 text-meta leading-snug text-faint">
                  The saved query string is kept unless you add a new one.
                </div>
              )}
              <McpKeyValueRows
                label="Headers"
                hint={
                  hasSavedHeaders
                    ? "Sent with every request. Saved values stay unless you replace them."
                    : "Sent with every request. Stored in mcp-config.json."
                }
                addLabel="Add header"
                itemNoun="Header"
                namePlaceholder="Authorization"
                valuePlaceholder="Bearer <api-key>"
                savedValuePlaceholder="Leave blank to keep"
                rows={headerRows}
                onChange={setHeaderRows}
              />
            </>
          ) : (
            <>
              <Field label="Command">
                <input
                  ref={firstFieldRef}
                  className={cn(
                    settingsInputClass,
                    "font-mono phone:min-h-11 phone:text-input-phone",
                  )}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="~/bin/my-mcp"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label="Args (space-separated)">
                <input
                  className={cn(
                    settingsInputClass,
                    "font-mono phone:min-h-11 phone:text-input-phone",
                  )}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="run /path/to/server.ts"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <McpKeyValueRows
                label="Environment"
                hint={
                  hasSavedEnv
                    ? "Stored in mcp-config.json. Saved values stay unless you replace them."
                    : "Stored in mcp-config.json. A key with no value is read from the process environment."
                }
                addLabel="Add variable"
                itemNoun="Variable"
                namePlaceholder="API_KEY"
                valuePlaceholder="Value or ${ENV_NAME}"
                savedValuePlaceholder="Leave blank to keep"
                rows={envRows}
                onChange={setEnvRows}
              />
            </>
          )}

          <Field label="Allowed users (optional, comma-separated, blank for everyone)">
            <input
              className={cn(
                settingsInputClass,
                "phone:min-h-11 phone:text-input-phone",
              )}
              value={allowedUsers}
              onChange={(e) => setAllowedUsers(e.target.value)}
              placeholder="Alice, Bob"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          {error && <InlineAlert>{error}</InlineAlert>}

          <Modal.Footer>
            <Button
              variant="ghost"
              onClick={onClose}
              disabled={saving}
              className="phone:min-h-11"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={saving || !valid}
              className="phone:min-h-11"
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </Modal.Footer>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}

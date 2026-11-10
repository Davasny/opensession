import { useEffect, useState } from "react";
import { request } from "../lib/api/request";
import { errorMessage } from "../lib/error-message";
import {
  fetchLinearApps,
  linearAppCredentials,
  type LinearApp,
} from "../lib/linear-apps";
import { Button } from "../ui/button";
import { useConfirm } from "../ui/confirm";
import { Disclosure } from "../ui/disclosure";
import { Input } from "../ui/input";
import { SettingsSection } from "../ui/settings";
import { InlineAlert, LoadingState } from "../ui/state";
import { IconArrowUpRight } from "./icons";
import { CopyableCode, StateChip } from "./setup-shared";
import { LinearAppAutomation } from "./LinearAppAutomation";

export function LinearAgentSettings({ onChanged }: { onChanged: () => void }) {
  const [apps, setApps] = useState<LinearApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirm, confirmElement] = useConfirm();
  useEffect(() => {
    let ignore = false;
    fetchLinearApps()
      .then((result) => {
        if (!ignore) {
          setApps(result);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!ignore)
          setError(errorMessage(cause, "Could not load Linear apps"));
      });
    return () => {
      ignore = true;
    };
  }, [reload]);
  function changed() {
    setAdding(false);
    setReload((value) => value + 1);
    onChanged();
  }
  function remove(app: LinearApp) {
    confirm({
      title: `Remove ${app.name}?`,
      description:
        "This removes the app configuration from Open Session. New runs will be rejected, but a running turn may finish. The OAuth app stays in Linear. This does not revoke its tokens.",
      confirmLabel: "Remove app",
      destructive: true,
      onConfirm: () => {
        setRemoving(app.id);
        void request(`/connections/linear/apps/${encodeURIComponent(app.id)}`, {
          method: "DELETE",
          label: "Could not remove Linear app",
        })
          .then(changed)
          .catch((cause: unknown) => {
            setError(errorMessage(cause, "Could not remove Linear app"));
          })
          .finally(() => setRemoving(null));
      },
    });
  }
  return (
    <section aria-label="Linear apps" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <h3 className="m-0 text-item-title font-semibold text-fg">
          Linear apps
        </h3>
        <Button
          size="sm"
          className="phone:min-h-11"
          disabled={adding || !apps}
          onClick={() => setAdding(true)}
        >
          Add app
        </Button>
      </div>
      <p className="m-0 px-1 text-supporting text-dim">
        Each OAuth app has its own agent and instructions. App and credential
        changes apply without a restart when Linear is enabled. Only enabling
        Linear requires a restart.
      </p>
      {error && (
        <InlineAlert onRetry={() => setReload((value) => value + 1)}>
          {error}
        </InlineAlert>
      )}
      {!apps && !error && <LoadingState>Loading Linear apps</LoadingState>}
      {adding && (
        <SettingsSection className="border-0 bg-panel p-4">
          <h4 className="mb-3 mt-0 text-item-title font-medium text-fg">
            Add Linear app
          </h4>
          <LinearAppCredentials
            app={null}
            onSaved={changed}
            onCancel={() => setAdding(false)}
          />
        </SettingsSection>
      )}
      {apps?.map((app) => (
        <SettingsSection
          key={app.id}
          className="flex min-w-0 flex-col gap-4 border-0 bg-panel p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="m-0 min-w-0 break-words text-item-title font-medium text-fg">
              {app.name}
            </h4>
            {app.id === "primary" && (
              <span className="text-meta text-faint">Primary app</span>
            )}
            <StateChip
              tone={
                app.clientId &&
                app.clientSecretConfigured &&
                app.webhookConfigured
                  ? "on"
                  : "warn"
              }
              label={
                app.clientId &&
                app.clientSecretConfigured &&
                app.webhookConfigured
                  ? "Credentials saved"
                  : "Setup incomplete"
              }
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {app.clientId && app.clientSecretConfigured && (
              <Button
                size="sm"
                className="phone:min-h-11"
                icon={<IconArrowUpRight size={16} />}
                render={
                  <a href={app.authorizeUrl} target="_blank" rel="noreferrer" />
                }
              >
                Connect
              </Button>
            )}
            {app.id !== "primary" && (
              <Button
                size="sm"
                variant="danger"
                className="phone:min-h-11"
                disabled={removing !== null}
                onClick={() => remove(app)}
              >
                {removing === app.id ? "Removing…" : "Remove app"}
              </Button>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <div className="min-w-0">
              <div className="mb-1 text-label text-dim">OAuth callback URL</div>
              <CopyableCode value={app.callbackUrl} />
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-label text-dim">Webhook URL</div>
              <CopyableCode value={app.webhookUrl} />
            </div>
          </div>
          <Disclosure
            title="App credentials"
            defaultOpen={!app.clientSecretConfigured}
          >
            <LinearAppCredentials app={app} onSaved={changed} />
          </Disclosure>
          <Disclosure title="Agent instructions and tools">
            <LinearAppAutomation
              app={app}
              onSaved={() => setReload((value) => value + 1)}
            />
          </Disclosure>
        </SettingsSection>
      ))}
      {confirmElement}
    </section>
  );
}

function LinearAppCredentials({
  app,
  onSaved,
  onCancel,
}: {
  app: LinearApp | null;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(app?.name ?? "");
  const [oauthClientId, setClientId] = useState(app?.clientId ?? "");
  const [oauthClientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty =
    !app ||
    name.trim() !== app.name ||
    oauthClientId.trim() !== app.clientId ||
    Boolean(oauthClientSecret.trim() || webhookSecret.trim());
  const valid =
    name.trim() &&
    oauthClientId.trim() &&
    (app?.clientSecretConfigured || oauthClientSecret.trim()) &&
    (app?.webhookConfigured || webhookSecret.trim());
  async function save() {
    if (saving || !dirty || !valid) return;
    setSaving(true);
    setError(null);
    try {
      await request(
        app
          ? `/connections/linear/apps/${encodeURIComponent(app.id)}`
          : "/connections/linear/apps",
        {
          method: app ? "PUT" : "POST",
          body: linearAppCredentials({
            name,
            oauthClientId,
            oauthClientSecret,
            webhookSecret,
          }),
          label: "Could not save Linear app",
        },
      );
      setClientSecret("");
      setWebhookSecret("");
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "Could not save Linear app"));
    }
    setSaving(false);
  }
  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="flex flex-col gap-1.5 text-label text-fg">
        App name
        <Input
          value={name}
          autoFocus={!app}
          onChange={(event) => setName(event.target.value)}
          disabled={saving}
          required
          className="phone:min-h-11 phone:text-input-phone"
          autoComplete="off"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-label text-fg">
        OAuth client ID
        <Input
          value={oauthClientId}
          readOnly={Boolean(app?.clientId)}
          onChange={(event) => setClientId(event.target.value)}
          disabled={saving}
          required
          className="phone:min-h-11 phone:text-input-phone"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        {app?.clientId && (
          <span className="text-supporting text-dim">
            Client ID cannot be changed after setup.
          </span>
        )}
      </label>
      <label className="flex flex-col gap-1.5 text-label text-fg">
        OAuth client secret
        <Input
          type="password"
          value={oauthClientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          placeholder={
            app?.clientSecretConfigured
              ? "Configured. Leave blank to keep."
              : "Client secret"
          }
          required={!app?.clientSecretConfigured}
          disabled={saving}
          className="phone:min-h-11 phone:text-input-phone"
          autoComplete="new-password"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-label text-fg">
        Webhook secret
        <Input
          type="password"
          value={webhookSecret}
          onChange={(event) => setWebhookSecret(event.target.value)}
          placeholder={
            app?.webhookConfigured
              ? "Configured. Leave blank to keep."
              : "Webhook signing secret"
          }
          required={!app?.webhookConfigured}
          disabled={saving}
          className="phone:min-h-11 phone:text-input-phone"
          autoComplete="new-password"
        />
      </label>
      <p className="m-0 text-meta text-faint">
        Secrets are never shown back. Credential changes apply without a
        restart.
      </p>
      {error && <InlineAlert>{error}</InlineAlert>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          className="phone:min-h-11"
          disabled={saving || !dirty || !valid}
        >
          {saving ? "Saving…" : app ? "Save credentials" : "Add app"}
        </Button>
        {onCancel && (
          <Button
            variant="ghost"
            className="phone:min-h-11"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

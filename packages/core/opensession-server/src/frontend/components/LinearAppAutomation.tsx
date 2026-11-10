import { useEffect, useState } from "react";
import { fetchModels, type ModelOption } from "../lib/api/automations";
import { request } from "../lib/api/request";
import { errorMessage } from "../lib/error-message";
import type { LinearApp } from "../lib/linear-apps";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { OptionSelect } from "../ui/select";
import { InlineAlert } from "../ui/state";
import { Switch } from "../ui/switch";
import { McpPicker } from "./Automations";

export function LinearAppAutomation({
  app,
  onSaved,
}: {
  app: LinearApp;
  onSaved: () => void;
}) {
  const [prompt, setPrompt] = useState(app.automation?.prompt ?? "");
  const [mode, setMode] = useState<"scratch" | "ask" | "code">(
    app.automation?.mode ?? "code",
  );
  const [model, setModel] = useState(app.automation?.model ?? "");
  const [repo, setRepo] = useState(app.automation?.repo ?? "");
  const [enabled, setEnabled] = useState(app.automation?.enabled ?? true);
  const [mcpServers, setMcpServers] = useState<string[]>(
    app.automation?.mcpServers ?? [],
  );
  const [models, setModels] = useState<ModelOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let ignore = false;
    fetchModels()
      .then((result) => {
        if (!ignore) setModels(result.models);
      })
      .catch((cause: unknown) => {
        if (!ignore)
          setModelError(errorMessage(cause, "Could not load models"));
      });
    return () => {
      ignore = true;
    };
  }, []);
  const dirty =
    prompt !== (app.automation?.prompt ?? "") ||
    mode !== (app.automation?.mode ?? "code") ||
    model !== (app.automation?.model ?? "") ||
    repo !== (app.automation?.repo ?? "") ||
    enabled !== (app.automation?.enabled ?? true) ||
    JSON.stringify(mcpServers) !==
      JSON.stringify(app.automation?.mcpServers ?? []);
  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await request(`/connections/linear/apps/${encodeURIComponent(app.id)}`, {
        method: "PUT",
        body: {
          automation: {
            prompt,
            mode,
            model,
            repo: repo.trim(),
            enabled,
            mcpServers,
          },
        },
        label: "Could not save Linear agent settings",
      });
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "Could not save Linear agent settings"));
    }
    setSaving(false);
  }
  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!app.automation && (
        <InlineAlert variant="warn">
          This app currently uses the legacy coding workflow. Saving these
          settings switches it to the selected task mode and instructions.
        </InlineAlert>
      )}
      <fieldset
        disabled={saving}
        className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
      >
        <div className="flex items-center justify-between gap-3 text-label text-fg">
          <span>Enable agent runs</span>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label="Enable agent runs"
          />
        </div>
        <label className="flex flex-col gap-1.5 text-label text-fg">
          Task mode
          <OptionSelect
            label="Task mode"
            value={mode}
            options={[
              { value: "scratch", label: "General task" },
              { value: "ask", label: "Repository read-only" },
              { value: "code", label: "Coding" },
            ]}
            onChange={(value) => {
              if (value === "scratch" || value === "ask" || value === "code")
                setMode(value);
            }}
            className="phone:min-h-11"
          />
        </label>
        {mode !== "scratch" && (
          <label className="flex flex-col gap-1.5 text-label text-fg">
            Repository
            <Input
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="acme/project"
              className="phone:min-h-11 phone:text-input-phone"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="text-supporting text-dim">
              Leave blank to use the instance default repository.
            </span>
          </label>
        )}
        <label className="flex flex-col gap-1.5 text-label text-fg">
          Instructions
          <Textarea
            rows={8}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe what this agent should do when assigned an issue."
            className="phone:text-input-phone"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-label text-fg">
          Model
          <OptionSelect
            label="Model"
            value={model}
            options={[
              { value: "", label: "Default model" },
              ...models.map((item) => ({ value: item.id, label: item.label })),
              ...(model && !models.some((item) => item.id === model)
                ? [{ value: model, label: model }]
                : []),
            ]}
            onChange={setModel}
            className="phone:min-h-11"
          />
        </label>
        {modelError && <InlineAlert>{modelError}</InlineAlert>}
        <McpPicker
          value={mcpServers}
          onChange={(value) => setMcpServers(value ?? [])}
          allowAll={false}
          requiredServers={[]}
        />
      </fieldset>
      {error && <InlineAlert>{error}</InlineAlert>}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          className="phone:min-h-11"
          disabled={saving || (!dirty && app.automation !== null)}
        >
          {saving ? "Saving…" : "Save agent settings"}
        </Button>
        <span role="status" className="text-meta text-faint">
          {saved
            ? "Saved. Instructions, model, and tools apply to the next turn. Task mode and repository apply to new assignments."
            : "Instructions, model, and tools apply to the next turn. Task mode and repository apply to new assignments. No restart needed."}
        </span>
      </div>
    </form>
  );
}

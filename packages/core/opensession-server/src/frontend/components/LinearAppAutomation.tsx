import { useEffect, useState } from "react";
import { fetchModels, type ModelOption } from "../lib/api/automations";
import { fetchRepos, type RepoInfo } from "../lib/api/repos";
import { request } from "../lib/api/request";
import { errorMessage } from "../lib/error-message";
import type { LinearApp } from "../lib/linear-apps";
import { Button } from "../ui/button";
import { Textarea } from "../ui/input";
import { OptionSelect } from "../ui/select";
import { InlineAlert } from "../ui/state";
import { Switch } from "../ui/switch";
import { McpPicker } from "./Automations";
import { ModelEffortSelect } from "./ModelEffortSelect";

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
  const [effort, setEffort] = useState(app.automation?.effort ?? "");
  const [repo, setRepo] = useState(app.automation?.repo ?? "");
  const [enabled, setEnabled] = useState(app.automation?.enabled ?? true);
  const [mcpAll, setMcpAll] = useState(app.automation?.mcpAll ?? false);
  const [mcpServers, setMcpServers] = useState<string[]>(
    app.automation?.mcpServers ?? [],
  );
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let ignore = false;
    fetchModels()
      .then((result) => {
        if (ignore) return;
        setModels(result.models);
        setDefaultModel(result.automationDefault ?? result.default);
      })
      .catch((cause: unknown) => {
        if (!ignore)
          setModelError(errorMessage(cause, "Could not load models"));
      });
    return () => {
      ignore = true;
    };
  }, []);
  useEffect(() => {
    let ignore = false;
    fetchRepos()
      .then((result) => {
        if (!ignore) setRepos(result);
      })
      .catch((cause: unknown) => {
        if (!ignore)
          setRepoError(errorMessage(cause, "Could not load repositories"));
      });
    return () => {
      ignore = true;
    };
  }, []);
  // The picker watches the selected model's ladder. Keep a stored effort only
  // while the model still publishes it; otherwise fall back to the model's own
  // default instead of saving a level this model cannot run.
  const effectiveModel = model || defaultModel;
  useEffect(() => {
    if (!effort) return;
    const entry = models.find((item) => item.id === effectiveModel);
    if (entry && !entry.efforts.includes(effort)) setEffort("");
  }, [models, effectiveModel, effort]);
  const dirty =
    prompt !== (app.automation?.prompt ?? "") ||
    mode !== (app.automation?.mode ?? "code") ||
    model !== (app.automation?.model ?? "") ||
    effort !== (app.automation?.effort ?? "") ||
    repo !== (app.automation?.repo ?? "") ||
    enabled !== (app.automation?.enabled ?? true) ||
    mcpAll !== (app.automation?.mcpAll ?? false) ||
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
            effort,
            repo: repo.trim(),
            enabled,
            mcpAll,
            mcpServers: mcpAll ? [] : mcpServers,
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
  const defaultRepo = repos.find((item) => item.default);
  const repoOptions = [
    {
      value: "",
      label: `Instance default${defaultRepo ? ` · ${defaultRepo.label || defaultRepo.id}` : ""}`,
    },
    ...repos.map((item) => ({
      value: item.id,
      label: item.label || item.id,
    })),
    ...(repos.length > 0 && repo && !repos.some((item) => item.id === repo)
      ? [{ value: repo, label: `${repo} · not registered` }]
      : []),
  ];
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
            <OptionSelect
              label="Repository"
              value={repo}
              options={repoOptions}
              onChange={setRepo}
              className="phone:min-h-11"
            />
            <span className="text-supporting text-dim">
              Coding and read-only tasks check out this repository.
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
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-label text-fg">Model</span>
          <ModelEffortSelect
            selection={{
              models:
                model && !models.some((item) => item.id === model)
                  ? [
                      ...models,
                      {
                        id: model,
                        provider: "pi",
                        label: model,
                        aliases: [],
                        efforts: [],
                      },
                    ]
                  : models,
              defaultModel,
              model,
              effort,
            }}
            appearance={{
              triggerVariant: "field",
              disabled: saving,
              className: "phone:min-h-11",
              title: "Model and reasoning effort",
            }}
            actions={{
              changeModel: setModel,
              changeEffort: setEffort,
              reset: () => {
                setModel("");
                setEffort("");
              },
            }}
          />
          <span className="text-supporting text-dim">
            Models are grouped by provider. Effort follows the selected model.
            Default follows the instance model.
          </span>
        </div>
        {modelError && <InlineAlert>{modelError}</InlineAlert>}
        {repoError && <InlineAlert>{repoError}</InlineAlert>}
        <McpPicker
          value={mcpAll ? undefined : mcpServers}
          onChange={(value) => {
            if (value === undefined) {
              setMcpAll(true);
              return;
            }
            setMcpAll(false);
            setMcpServers(value);
          }}
          allowAll
          builtInServers={["linear"]}
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
            ? "Saved. Instructions, model, effort, and tools apply to the next turn. Task mode and repository apply to new assignments."
            : "Instructions, model, effort, and tools apply to the next turn. Task mode and repository apply to new assignments. No restart needed."}
        </span>
      </div>
    </form>
  );
}

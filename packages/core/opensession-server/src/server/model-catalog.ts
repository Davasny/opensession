import { listAccountsPublic } from "./claude-accounts";
import { listCodexAccountsPublic } from "./codex-accounts";
import { modelProviders, type ModelProviderConfig } from "./model-providers";
import { hasXaiAccounts } from "./xai-accounts";
import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";
import {
  KNOWN_MODELS,
  interactiveDefaultModel,
  refreshPickerModels,
  toPiModel,
} from "./models";

/** Provider capacity configured on this server. Temporary exhaustion does not
 * change the catalog or default; adding or removing an account does. */
export function configuredModelProviders(): Set<string> {
  return new Set([
    ...(listAccountsPublic().length ? ["anthropic"] : []),
    ...(listCodexAccountsPublic().length ? ["openai"] : []),
    ...(hasXaiAccounts() ? [XAI_OAUTH_PROVIDER] : []),
    ...Object.entries(modelProviders())
      .filter(([, provider]) => !!provider.apiKey)
      .map(([provider]) => provider),
  ]);
}

/** Display labels for the upstream providers we know by name. Configured
 *  providers can override theirs with `name` in Settings. */
const MODEL_PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  pi: "Pi",
  "xai-oauth": "xAI SuperGrok",
  xai: "xAI",
  meta: "Meta",
  google: "Google",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot AI",
  cerebras: "Cerebras",
  wafer: "Wafer",
};

/** A person-facing name for a routed model's upstream provider. */
export function modelVendorLabel(
  vendor: string,
  providers: Record<string, ModelProviderConfig> = modelProviders(),
): string {
  const configured = providers[vendor]?.name?.trim();
  if (configured) return configured;
  const known = MODEL_PROVIDER_LABELS[vendor];
  if (known) return known;
  return vendor
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Upstream provider needed to run one selectable model. */
export function modelUpstreamProvider(model: string): string | undefined {
  return toPiModel(model)?.match(/^pi\/([^/]+)\//)?.[1];
}

/** Picker/storage id for a selection. */
export function pickerModelId(model: string): string {
  return toPiModel(model) || model;
}

export function modelFitsConfiguredProviders(
  model: string,
  configuredProviders: ReadonlySet<string>,
): boolean {
  const provider = modelUpstreamProvider(model);
  return !!provider && configuredProviders.has(provider);
}

/** Capacity-aware default shared by the picker and untouched session creates. */
export function chooseConfiguredDefaultModel(
  preferred: string,
  configuredProviders: ReadonlySet<string>,
  fallbackModels: readonly string[],
): string {
  const normalizedPreferred = pickerModelId(preferred);
  if (modelFitsConfiguredProviders(normalizedPreferred, configuredProviders)) {
    return normalizedPreferred;
  }
  return (
    fallbackModels
      .map((model) => toPiModel(model) || model)
      .find((model) =>
        modelFitsConfiguredProviders(model, configuredProviders),
      ) || normalizedPreferred
  );
}

export function configuredInteractiveDefaultModel(
  configuredProviders = configuredModelProviders(),
): string {
  refreshPickerModels();
  return chooseConfiguredDefaultModel(
    interactiveDefaultModel(),
    configuredProviders,
    KNOWN_MODELS.filter((model) => model.provider === "pi").map(
      (model) => model.id,
    ),
  );
}

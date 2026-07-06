import { MODELS_BY_PROVIDER } from "@/assistant/llm-model-catalog";
import { useActiveAssistantIsSelfHosted } from "@/hooks/use-platform-gate";

import { INFERENCE_PROVIDERS } from "@/domains/settings/ai/constants";
import { CONNECTION_PROVIDERS } from "@/domains/settings/ai/provider-editor-constants";

import type { ConnectionProvider } from "@/generated/daemon/types.gen";

const LOCAL_ONLY_PROVIDERS = new Set<string>(["ollama"]);

// vellum is a managed connection type, not a profile LLM provider — it has no
// entry in LlmProvider, so it can't back a profile's `provider` field.
const CONNECTION_ONLY_PROVIDERS = new Set<string>(["vellum"]);

export function isProviderSelectableForAssistant(
  provider: string,
  activeAssistantIsSelfHosted: boolean,
): boolean {
  if (CONNECTION_ONLY_PROVIDERS.has(provider)) return false;
  return !LOCAL_ONLY_PROVIDERS.has(provider) || activeAssistantIsSelfHosted;
}

export function selectableInferenceProvidersForAssistant(
  activeAssistantIsSelfHosted: boolean,
): Array<(typeof INFERENCE_PROVIDERS)[number]> {
  return INFERENCE_PROVIDERS.filter((provider) =>
    isProviderSelectableForAssistant(provider, activeAssistantIsSelfHosted),
  );
}

export function selectableConnectionProvidersForAssistant(
  activeAssistantIsSelfHosted: boolean,
): ConnectionProvider[] {
  return CONNECTION_PROVIDERS.filter((provider) =>
    isProviderSelectableForAssistant(provider, activeAssistantIsSelfHosted),
  );
}

export function selectableCatalogProvidersForAssistant(
  activeAssistantIsSelfHosted: boolean,
): Array<keyof typeof MODELS_BY_PROVIDER> {
  return (
    Object.keys(MODELS_BY_PROVIDER) as Array<keyof typeof MODELS_BY_PROVIDER>
  ).filter((provider) =>
    isProviderSelectableForAssistant(provider, activeAssistantIsSelfHosted),
  );
}

export function useSelectableInferenceProviders(): Array<
  (typeof INFERENCE_PROVIDERS)[number]
> {
  const activeAssistantIsSelfHosted = useActiveAssistantIsSelfHosted();
  return selectableInferenceProvidersForAssistant(activeAssistantIsSelfHosted);
}

export function useSelectableConnectionProviders(): ConnectionProvider[] {
  const activeAssistantIsSelfHosted = useActiveAssistantIsSelfHosted();
  return selectableConnectionProvidersForAssistant(activeAssistantIsSelfHosted);
}

export function useSelectableCatalogProviders(): Array<
  keyof typeof MODELS_BY_PROVIDER
> {
  const activeAssistantIsSelfHosted = useActiveAssistantIsSelfHosted();
  return selectableCatalogProvidersForAssistant(activeAssistantIsSelfHosted);
}

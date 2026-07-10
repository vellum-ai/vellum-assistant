import { MODELS_BY_PROVIDER } from "@/assistant/llm-model-catalog";
import { useActiveAssistantIsSelfHosted } from "@/hooks/use-platform-gate";

import {
  INFERENCE_PROVIDERS,
  MANAGED_ROUTABLE_PROVIDERS,
  VELLUM_CONNECTION_PROVIDER,
} from "@/domains/settings/ai/constants";
import { CONNECTION_PROVIDERS } from "@/domains/settings/ai/provider-editor-constants";

import type {
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

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

/**
 * Selectable profile providers a set of connections can dispatch through, in
 * canonical picker order. A connection normally backs its own `provider`, but
 * the provider-agnostic Vellum-managed connection (the `vellum` sentinel)
 * serves every managed-routable provider, so it expands into that set. This is
 * what surfaces Anthropic/OpenAI/etc. in the profile provider picker for a
 * platform-hosted user whose only connection is the managed one, and surfaces
 * a BYOK provider (e.g. Anthropic) for a self-hosted user who entered that key.
 */
export function providersServedByConnections(
  connections: ProviderConnection[],
  activeAssistantIsSelfHosted: boolean,
): ConnectionProvider[] {
  const served = new Set<ConnectionProvider>();
  for (const connection of connections) {
    if (connection.provider === VELLUM_CONNECTION_PROVIDER) {
      for (const managed of CONNECTION_PROVIDERS) {
        if (MANAGED_ROUTABLE_PROVIDERS.has(managed)) {
          served.add(managed);
        }
      }
    } else {
      served.add(connection.provider);
    }
  }
  const selectable = [...served].filter((provider) =>
    isProviderSelectableForAssistant(provider, activeAssistantIsSelfHosted),
  );
  // Canonical picker order first; a provider absent from the catalog order (a
  // connection for a provider this app version doesn't list) is appended so
  // version drift never hides a selectable provider.
  return [
    ...CONNECTION_PROVIDERS.filter((provider) => selectable.includes(provider)),
    ...selectable.filter((provider) => !CONNECTION_PROVIDERS.includes(provider)),
  ];
}

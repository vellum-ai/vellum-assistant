import { MODELS_BY_PROVIDER } from "@/assistant/llm-model-catalog";
import { useActiveAssistantIsSelfHosted } from "@/hooks/use-platform-gate";

import {
  INFERENCE_PROVIDERS,
  VELLUM_CONNECTION_PROVIDER,
} from "@/domains/settings/ai/constants";
import { CONNECTION_PROVIDERS } from "@/domains/settings/ai/provider-editor-constants";

import type {
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

const LOCAL_ONLY_PROVIDERS = new Set<string>(["ollama"]);

export function isProviderSelectableForAssistant(
  provider: string,
  activeAssistantIsSelfHosted: boolean,
): boolean {
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
 * canonical picker order. A connection backs its own `provider`; the
 * Vellum-managed connection surfaces as a single "Vellum" entry (listed
 * first) rather than expanding into the upstreams it routes to — which
 * provider actually serves a Vellum model is an implementation detail users
 * never see. A BYOK provider (e.g. Anthropic) still surfaces for a user who
 * entered that key.
 */
export function providersServedByConnections(
  connections: ProviderConnection[],
  activeAssistantIsSelfHosted: boolean,
): ConnectionProvider[] {
  const served = new Set<ConnectionProvider>(
    connections.map((connection) => connection.provider),
  );
  const selectable = [...served].filter((provider) =>
    isProviderSelectableForAssistant(provider, activeAssistantIsSelfHosted),
  );
  // Vellum first, then canonical picker order; a provider absent from the
  // catalog order (a connection for a provider this app version doesn't
  // list) is appended so version drift never hides a selectable provider.
  const ordered: ConnectionProvider[] = [];
  if (selectable.includes(VELLUM_CONNECTION_PROVIDER)) {
    ordered.push(VELLUM_CONNECTION_PROVIDER);
  }
  ordered.push(
    ...CONNECTION_PROVIDERS.filter((provider) => selectable.includes(provider)),
    ...selectable.filter(
      (provider) =>
        provider !== VELLUM_CONNECTION_PROVIDER &&
        !CONNECTION_PROVIDERS.includes(provider),
    ),
  );
  return ordered;
}

import { MODELS_BY_PROVIDER } from "@/assistant/llm-model-catalog";
import { useActiveAssistantIsSelfHosted } from "@/hooks/use-platform-gate";

import {
  INFERENCE_PROVIDERS,
  OPENAI_COMPATIBLE_PROVIDER,
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

// ---------------------------------------------------------------------------
// Per-endpoint picker entries
// ---------------------------------------------------------------------------

/**
 * Picker-value encoding for one openai-compatible endpoint presented as its
 * own provider-like entry. Each custom endpoint is a named entry; the
 * profile pickers list them individually (labeled by the endpoint) instead
 * of one generic "OpenAI-compatible" entry plus a second field. The `::`
 * separator cannot collide with provider ids, which contain no colons.
 */
const ENDPOINT_PICKER_PREFIX = `${OPENAI_COMPATIBLE_PROVIDER}::`;

export function endpointPickerValue(connectionName: string): string {
  return `${ENDPOINT_PICKER_PREFIX}${connectionName}`;
}

/** The endpoint name inside a picker value, or null for plain provider ids. */
export function parseEndpointPickerValue(value: string): string | null {
  return value.startsWith(ENDPOINT_PICKER_PREFIX)
    ? value.slice(ENDPOINT_PICKER_PREFIX.length)
    : null;
}

/**
 * Provider dropdown entries with openai-compatible expanded per endpoint:
 * every other provider is one entry keyed by its id; each openai-compatible
 * connection is its own entry keyed by `endpointPickerValue(name)` and
 * labeled by the endpoint's label (falling back to its name).
 */
export function expandEndpointEntries(
  providers: readonly ConnectionProvider[],
  connections: ProviderConnection[],
  labelFor: (provider: ConnectionProvider) => string,
): { value: string; label: string; meta?: string }[] {
  const entries: { value: string; label: string; meta?: string }[] = [];
  for (const provider of providers) {
    if (provider === VELLUM_CONNECTION_PROVIDER) {
      entries.push({
        value: provider,
        label: labelFor(provider),
        meta: "Managed",
      });
      continue;
    }
    if (provider !== OPENAI_COMPATIBLE_PROVIDER) {
      entries.push({ value: provider, label: labelFor(provider) });
      continue;
    }
    for (const c of connections) {
      if (c.provider !== OPENAI_COMPATIBLE_PROVIDER) {
        continue;
      }
      entries.push({
        value: endpointPickerValue(c.name),
        label: c.label && c.label.trim() !== "" ? c.label : c.name,
        meta: "Custom",
      });
    }
  }
  return entries;
}

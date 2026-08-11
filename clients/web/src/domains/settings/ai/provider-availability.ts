import { MODELS_BY_PROVIDER } from "@/assistant/llm-model-catalog";
import { useActiveAssistantIsSelfHosted } from "@/hooks/use-platform-gate";

import {
  CHATGPT_CONNECTION_PROVIDER,
  INFERENCE_PROVIDERS,
  MANAGED_ROUTABLE_PROVIDERS,
  OPENAI_COMPATIBLE_PROVIDER,
  VELLUM_CONNECTION_PROVIDER,
} from "@/domains/settings/ai/constants";
import { CONNECTION_PROVIDERS } from "@/domains/settings/ai/provider-editor-constants";

import type {
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

const LOCAL_ONLY_PROVIDERS = new Set<string>(["ollama"]);

/**
 * Whether a connection (identified by its stored `provider`) can serve
 * requests for `selectedProvider`. One routing sentinel serves providers
 * other than its own column value: the provider-agnostic `vellum`
 * connection serves every managed-routable provider. The `chatgpt`
 * subscription connection serves only its own identity: dispatch matches
 * connections by exact provider, so an "openai" fragment cannot route
 * through the subscription (migration 144 converts stranded ones to the
 * chatgpt identity instead).
 */
export function connectionServesProvider(
  connectionProvider: string,
  selectedProvider: string,
): boolean {
  if (connectionProvider === selectedProvider) {
    return true;
  }
  return (
    connectionProvider === VELLUM_CONNECTION_PROVIDER &&
    MANAGED_ROUTABLE_PROVIDERS.has(selectedProvider)
  );
}

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
  // The subscription identity sits with the other first-class routes rather
  // than in the version-drift bucket at the end.
  if (selectable.includes(CHATGPT_CONNECTION_PROVIDER)) {
    ordered.push(CHATGPT_CONNECTION_PROVIDER);
  }
  ordered.push(
    ...CONNECTION_PROVIDERS.filter((provider) => selectable.includes(provider)),
    ...selectable.filter(
      (provider) =>
        provider !== VELLUM_CONNECTION_PROVIDER &&
        provider !== CHATGPT_CONNECTION_PROVIDER &&
        !CONNECTION_PROVIDERS.includes(provider),
    ),
  );
  return ordered;
}

/**
 * Selectable providers a set of connections cannot dispatch through yet, in
 * canonical picker order. These are offered as "connect me" entries: picking
 * one leads to the provider-create flow rather than binding a profile to a
 * route the daemon can't serve.
 *
 * `openai-compatible` is excluded — a custom endpoint has no identity until
 * the user names it and supplies a base URL, so it is reached through the
 * picker's dedicated create entry instead.
 */
export function unconnectedSelectableProviders(
  connections: ProviderConnection[],
  activeAssistantIsSelfHosted: boolean,
): ConnectionProvider[] {
  const served = new Set<ConnectionProvider>(
    connections.map((connection) => connection.provider),
  );
  return selectableConnectionProvidersForAssistant(
    activeAssistantIsSelfHosted,
  ).filter(
    (provider) =>
      provider !== OPENAI_COMPATIBLE_PROVIDER && !served.has(provider),
  );
}

// ---------------------------------------------------------------------------
// Per-entry picker entries
// ---------------------------------------------------------------------------

/**
 * Picker-value encoding for one connection (entry) presented as its own
 * provider-like row: `<provider>::<connection name>`. Every openai-compatible
 * endpoint is a named entry; a catalog provider expands into named entries
 * only when it has more than one connection (a single-key user never sees
 * entry naming). The `::` separator cannot collide with provider ids, which
 * contain no colons.
 */
const ENTRY_PICKER_SEPARATOR = "::";

export function entryPickerValue(
  provider: string,
  connectionName: string,
): string {
  return `${provider}${ENTRY_PICKER_SEPARATOR}${connectionName}`;
}

/** The provider and entry name inside a picker value, or null for plain
 * provider ids. */
export function parseEntryPickerValue(
  value: string,
): { provider: ConnectionProvider; connectionName: string } | null {
  const index = value.indexOf(ENTRY_PICKER_SEPARATOR);
  if (index <= 0) {
    return null;
  }
  return {
    provider: value.slice(0, index) as ConnectionProvider,
    connectionName: value.slice(index + ENTRY_PICKER_SEPARATOR.length),
  };
}

const ROUTING_IDENTITY_KINDS = new Set<string>([
  VELLUM_CONNECTION_PROVIDER,
  CHATGPT_CONNECTION_PROVIDER,
]);

/**
 * Catalog kinds with two or more connections of that same kind. These expand
 * into per-entry picker rows so a profile can name WHICH key it uses. The
 * identity rows (vellum/chatgpt) never expand, being canonical singletons,
 * and openai-compatible always expands regardless of count.
 */
export function multiEntryProviderKinds(
  connections: ProviderConnection[],
): Set<ConnectionProvider> {
  const counts = new Map<ConnectionProvider, number>();
  for (const c of connections) {
    if (
      ROUTING_IDENTITY_KINDS.has(c.provider) ||
      c.provider === OPENAI_COMPATIBLE_PROVIDER
    ) {
      continue;
    }
    counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].filter(([, n]) => n >= 2).map(([p]) => p),
  );
}

/**
 * Provider dropdown entries with multi-entry kinds expanded per connection:
 * a single-connection catalog provider is one entry keyed by its id; each
 * openai-compatible connection is its own entry; a catalog provider with two
 * or more connections keeps its bare id row (the kind's default entry) and
 * adds one row per named entry, labeled by the entry's label (falling back
 * to its name).
 */
export function expandEndpointEntries(
  providers: readonly ConnectionProvider[],
  connections: ProviderConnection[],
  labelFor: (provider: ConnectionProvider) => string,
  // User-facing copy is caller-supplied so it can come from the locale
  // catalog; the fallback keeps the pure helper usable in tests.
  defaultEntryMetaLabel = "Default",
): { value: string; label: string; meta?: string }[] {
  const multiEntryKinds = multiEntryProviderKinds(connections);
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
    if (provider === OPENAI_COMPATIBLE_PROVIDER) {
      for (const c of connections) {
        if (c.provider !== OPENAI_COMPATIBLE_PROVIDER) {
          continue;
        }
        entries.push({
          value: entryPickerValue(provider, c.name),
          label: c.label && c.label.trim() !== "" ? c.label : c.name,
          meta: "Custom",
        });
      }
      continue;
    }
    if (!multiEntryKinds.has(provider)) {
      entries.push({ value: provider, label: labelFor(provider) });
      continue;
    }
    // The bare id row stays selectable: it means "the kind's default
    // entry", which is how unbound profiles dispatch.
    entries.push({
      value: provider,
      label: labelFor(provider),
      meta: defaultEntryMetaLabel,
    });
    for (const c of connections) {
      if (c.provider !== provider) {
        continue;
      }
      entries.push({
        value: entryPickerValue(provider, c.name),
        label: c.label && c.label.trim() !== "" ? c.label : c.name,
        meta: labelFor(provider),
      });
    }
  }
  return entries;
}

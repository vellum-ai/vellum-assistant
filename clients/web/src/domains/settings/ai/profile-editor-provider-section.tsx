import { useEffect, useMemo } from "react";

import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Typography } from "@vellumai/design-library/components/typography";

import {
    getModelsForProvider,
    PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";

import { OPENAI_COMPATIBLE_PROVIDER } from "@/domains/settings/ai/constants";
import { useSelectableCatalogProviders } from "@/domains/settings/ai/provider-availability";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { ConnectionModel, ConnectionProvider, ProviderConnection } from "@/generated/daemon/types.gen";

const CODEX_SUBSCRIPTION_MODEL_IDS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
]);

function connectionModelsToCatalog(models: ConnectionModel[] | null | undefined) {
  return (models ?? []).map((m) => ({
    id: m.id,
    displayName: m.displayName ?? m.id,
  }));
}

/**
 * Copy for the Model field's empty states, keyed by the `modelEmptyState`
 * discriminator. The "no-provider" hint is `null` because the hint only
 * renders once a provider is selected.
 */
const MODEL_EMPTY_STATE_COPY = {
  "no-provider": {
    placeholder: "Select a provider first",
    hint: null,
  },
  "configure-connection": {
    placeholder: "Configure models on connection",
    hint: "No models available. Configure models on the provider connection first.",
  },
  "unknown-to-catalog": {
    placeholder: "No models available",
    hint: "No models are available for this provider in this app version. Update the app, or use an OpenAI-compatible connection to enter a custom model.",
  },
} as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProfileEditorProviderSectionProps {
  provider: ConnectionProvider | "";
  model: string;
  providerConnection: string;
  onProviderChange: (newProvider: ConnectionProvider) => void;
  onModelChange: (newModel: string) => void;
  onConnectionChange: (newConnection: string) => void;
  connections: ProviderConnection[] | undefined;
  isReadOnly: boolean;
  /** Connections matching the current provider, computed by the parent
   *  (the save handler also needs this for binding resolution). */
  availableConnectionsForProvider: ProviderConnection[];
  /** True when the saved binding no longer points at any known connection. */
  connectionNotFound: boolean;
  /**
   * Hide the Provider dropdown (and its empty-state hint). The create-mode
   * profile editor renders its own provider picker — with a "+ Create new
   * provider" sentinel and inline create form — and reuses this component
   * only for the Connection + Model fields below.
   */
  hideProviderField?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Provider + Connection + Model picker section of the profile editor.
 *
 * Owns the derived picker state (visible providers, provider-options source,
 * available models, connection field visibility) and the corresponding JSX.
 * The parent retains the actual form field values and change handlers because
 * provider changes cascade into advanced-param resets that the parent owns.
 */
export function ProfileEditorProviderSection({
  provider,
  model,
  providerConnection,
  onProviderChange,
  onModelChange,
  onConnectionChange,
  connections,
  isReadOnly,
  availableConnectionsForProvider,
  connectionNotFound,
  hideProviderField = false,
}: ProfileEditorProviderSectionProps) {
  const isMobile = useIsMobile();
  const providerMissing = provider.length === 0;
  const providerWithoutModel = provider.length > 0 && model.length === 0;

  const allProvidersForPicker = useSelectableCatalogProviders();

  // Filter to providers with at least one connection — picking a provider
  // with zero connections binds a profile to a route the daemon can't
  // dispatch through. The currently-bound `provider` is always kept so
  // editing a stale profile still renders a sensible trigger.
  const visibleProviders = useMemo(() => {
    const providerSet = new Set<string>();
    for (const c of connections ?? []) {
      providerSet.add(c.provider);
    }
    if (provider) {
      providerSet.add(provider);
    }
    return allProvidersForPicker.filter((p) => providerSet.has(p));
  }, [
    allProvidersForPicker,
    connections,
    provider,
  ]);

  // Pre-load fallback: when `connections` is `undefined` the parent hasn't
  // resolved its `listConnections` fetch yet. Fall back to the full catalog
  // so the trigger isn't empty during that gap. An EMPTY-but-loaded
  // `connections === []` is distinct: zero connections confirmed, so the
  // filter runs and yields empty — the empty-state hint fires.
  const providerOptionsSource =
    connections === undefined ? allProvidersForPicker : visibleProviders;

  // Show the Connection field whenever there's something meaningful to show:
  //  - matching connections to pick from, OR
  //  - a non-empty saved binding (so the user can see + clear stale state).
  // Provider must be selected; without it we can't filter or label.
  const showConnectionField =
    provider !== "" &&
    (availableConnectionsForProvider.length > 0 ||
      providerConnection !== "");

  // For openai-compatible providers the static catalog is empty — use models
  // from the selected connection instead. When no specific connection is
  // selected, merge models from all available openai-compatible connections.
  const availableModels: readonly { id: string; displayName: string }[] = useMemo(() => {
    if (!provider) return [];
    const catalogModels = getModelsForProvider(provider);
    if (catalogModels.length > 0) {
      const selectedConn = providerConnection
        ? availableConnectionsForProvider.find((c) => c.name === providerConnection)
        : undefined;
      if (selectedConn?.auth.type === "oauth_subscription") {
        return catalogModels.filter((m) => CODEX_SUBSCRIPTION_MODEL_IDS.has(m.id));
      }
      if (
        !providerConnection &&
        availableConnectionsForProvider.length > 0 &&
        availableConnectionsForProvider.every((c) => c.auth.type === "oauth_subscription")
      ) {
        return catalogModels.filter((m) => CODEX_SUBSCRIPTION_MODEL_IDS.has(m.id));
      }
      return catalogModels;
    }
    // Static catalog is empty (openai-compatible) — derive from connections.
    if (providerConnection) {
      const conn = availableConnectionsForProvider.find((c) => c.name === providerConnection);
      return conn ? connectionModelsToCatalog(conn.models) : [];
    }
    // No specific connection: merge models from all available connections,
    // deduplicating by id.
    const seen = new Set<string>();
    const merged: { id: string; displayName: string }[] = [];
    for (const conn of availableConnectionsForProvider) {
      for (const m of conn.models ?? []) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          merged.push({ id: m.id, displayName: m.displayName ?? m.id });
        }
      }
    }
    return merged;
  }, [
    provider,
    providerConnection,
    availableConnectionsForProvider,
  ]);

  // The Model dropdown always offers the profile's currently-bound model, even
  // when it's absent from the static catalog — a profile can be bound (via Chat)
  // to a model this build doesn't list: a new or cloaked provider model, or one
  // carried only on the connection. Label it from the catalog, then connection
  // models, then the raw id.
  const modelOptions: readonly { id: string; displayName: string }[] = useMemo(() => {
    if (!model || availableModels.some((m) => m.id === model)) {
      return availableModels;
    }
    const fromCatalog = getModelsForProvider(provider).find((m) => m.id === model);
    const fromConnection = availableConnectionsForProvider
      .flatMap((c) => c.models ?? [])
      .find((m) => m.id === model);
    const displayName =
      fromCatalog?.displayName ?? fromConnection?.displayName ?? model;
    return [...availableModels, { id: model, displayName }];
  }, [model, availableModels, provider, availableConnectionsForProvider]);

  // Single discriminator for the Model field's empty states — the dropdown
  // placeholder and the hint below both derive from it so the two can't
  // drift apart.
  const modelEmptyState = !provider
    ? "no-provider"
    : availableModels.length === 0
      ? provider === OPENAI_COMPATIBLE_PROVIDER
        ? "configure-connection"
        : "unknown-to-catalog"
      : null;
  const modelEmptyStateCopy = modelEmptyState
    ? MODEL_EMPTY_STATE_COPY[modelEmptyState]
    : null;

  // Clear the bound model when it isn't selectable for the current connection.
  // Per-connection providers (openai-compatible) derive their model list from
  // the connection, so a binding the connection doesn't offer must clear. For a
  // catalog-backed provider a model that's entirely absent from the catalog is a
  // newer/cloaked model the build doesn't list — keep it, clearing it would wipe
  // a working profile. But a model that IS in the catalog yet filtered out of
  // availableModels (e.g. a non-Codex model under a ChatGPT subscription
  // connection) is a known-incompatible binding and still clears. The parent's
  // handleProviderChange resets the model on provider switch, so this never
  // strands a cross-provider binding.
  useEffect(() => {
    if (!provider) return;
    const catalogModels = getModelsForProvider(provider);
    if (catalogModels.length > 0 && !catalogModels.some((m) => m.id === model)) {
      return;
    }
    if (
      model &&
      availableModels.length > 0 &&
      !availableModels.some((m) => m.id === model)
    ) {
      onModelChange("");
    }
  }, [model, availableModels, onModelChange, provider]);

  return (
    <>
      {/* Provider — required. Filtered to providers with at least one
          connection so users can't bind a profile to a non-dispatchable
          route. Hidden when the parent renders its own provider picker. */}
      {!hideProviderField && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label
              id="profile-editor-provider-label"
              className="block text-body-small-default text-[var(--content-tertiary)]"
            >
              Provider
            </label>
            {providerMissing && !isMobile ? (
              <span className="rounded-full bg-[var(--surface-warning-subtle)] px-2 py-0.5 text-body-small-default text-[var(--content-warning)]">
                Pick a provider
              </span>
            ) : null}
          </div>
          <Dropdown
            value={provider}
            onChange={onProviderChange}
            disabled={isReadOnly}
            placeholder="Select a provider…"
            aria-labelledby="profile-editor-provider-label"
            options={providerOptionsSource.map((p) => ({
              value: p,
              label: PROVIDER_DISPLAY_NAMES[p] ?? p,
            }))}
          />
          {providerOptionsSource.length === 0 && !isReadOnly ? (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              No provider connections. Open Providers to add one.
            </Typography>
          ) : null}
        </div>
      )}

      {/* Connection — visible when matching connections exist or a saved
          binding exists (even if stale). */}
      {showConnectionField && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Connection{" "}
            <span className="text-[var(--content-disabled)]">(optional)</span>
          </label>
          <Dropdown
            value={providerConnection}
            onChange={onConnectionChange}
            disabled={isReadOnly}
            options={[
              ...(availableConnectionsForProvider.length > 1
                ? [
                    {
                      value: "",
                      label: `Any ${
                        PROVIDER_DISPLAY_NAMES[provider] ?? provider
                      } connection`,
                    },
                  ]
                : []),
              ...availableConnectionsForProvider.map((c) => ({
                value: c.name,
                label:
                  c.label && c.label.trim() !== "" ? c.label : c.name,
              })),
              // Include the stale binding as an explicit option so the trigger
              // renders its name. The warning below explains the state; on save,
              // stale bindings are auto-cleared regardless.
              ...(connectionNotFound
                ? [
                    {
                      value: providerConnection,
                      label: `${providerConnection} (not found)`,
                    },
                  ]
                : []),
            ]}
          />
          {connectionNotFound && !isReadOnly ? (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-(--system-negative-strong)"
            >
              Connection &ldquo;{providerConnection}&rdquo; not found.
              Will be cleared on save unless you pick another.
            </Typography>
          ) : null}
        </div>
      )}

      {/* Model — required once a provider is selected. */}
      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          Model
        </label>
        <Dropdown
          value={model}
          onChange={onModelChange}
          disabled={isReadOnly || !provider}
          options={[
            {
              value: "",
              label: modelEmptyStateCopy?.placeholder ?? "Select a model",
            },
            ...modelOptions.map((m) => ({
              value: m.id,
              label: m.displayName,
            })),
          ]}
        />
        {providerWithoutModel && !isReadOnly ? (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-(--system-negative-strong)"
          >
            {modelEmptyStateCopy?.hint ?? "Select a model."}
          </Typography>
        ) : null}
      </div>
    </>
  );
}

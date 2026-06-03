import { useEffect, useMemo } from "react";

import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Typography } from "@vellum/design-library/components/typography";

import {
  getModelsForProvider,
  PROVIDER_DISPLAY_NAMES as INFERENCE_PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";

import type { ConnectionModel, ProviderConnection } from "@/domains/settings/ai/provider-connections-client";
import {
  ALL_PROVIDERS,
  CODEX_SUBSCRIPTION_MODEL_IDS,
  OPENAI_COMPATIBLE_PROVIDER,
} from "@/domains/settings/ai/profile-editor-constants";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProfileEditorProviderSectionProps {
  provider: string;
  model: string;
  providerConnection: string;
  onProviderChange: (newProvider: string) => void;
  onModelChange: (newModel: string) => void;
  onConnectionChange: (newConnection: string) => void;
  connections: ProviderConnection[] | undefined;
  openAICompatibleEndpointsEnabled: boolean;
  isReadOnly: boolean;
  /** Connections matching the current provider, computed by the parent
   *  (the save handler also needs this for binding resolution). */
  availableConnectionsForProvider: ProviderConnection[];
  /** True when the saved binding no longer points at any known connection. */
  connectionNotFound: boolean;
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
  openAICompatibleEndpointsEnabled,
  isReadOnly,
  availableConnectionsForProvider,
  connectionNotFound,
}: ProfileEditorProviderSectionProps) {
  const providerMissing = provider.length === 0;
  const providerWithoutModel = provider.length > 0 && model.length === 0;

  const allProvidersForPicker = useMemo(
    () =>
      openAICompatibleEndpointsEnabled
        ? ALL_PROVIDERS
        : ALL_PROVIDERS.filter((p) => p !== OPENAI_COMPATIBLE_PROVIDER),
    [openAICompatibleEndpointsEnabled],
  );

  // Filter to providers with at least one connection — picking a provider
  // with zero connections binds a profile to a route the daemon can't
  // dispatch through. The currently-bound `provider` is always kept so
  // editing a stale profile still renders a sensible trigger.
  const visibleProviders = useMemo(() => {
    const providerSet = new Set<string>();
    for (const c of connections ?? []) {
      if (
        openAICompatibleEndpointsEnabled ||
        c.provider !== OPENAI_COMPATIBLE_PROVIDER
      ) {
        providerSet.add(c.provider);
      }
    }
    if (
      provider &&
      (openAICompatibleEndpointsEnabled ||
        provider !== OPENAI_COMPATIBLE_PROVIDER)
    ) {
      providerSet.add(provider);
    }
    return allProvidersForPicker.filter((p) => providerSet.has(p));
  }, [
    allProvidersForPicker,
    connections,
    openAICompatibleEndpointsEnabled,
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
    if (
      provider === OPENAI_COMPATIBLE_PROVIDER &&
      !openAICompatibleEndpointsEnabled
    ) {
      return [];
    }
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
    const connectionModelsToCatalog = (models: ConnectionModel[] | null | undefined) =>
      (models ?? []).map((m) => ({
        id: m.id,
        displayName: m.displayName ?? m.id,
      }));
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
    openAICompatibleEndpointsEnabled,
    providerConnection,
    availableConnectionsForProvider,
  ]);

  // Auto-clear model when it's no longer in the available list (e.g. after
  // switching connections for openai-compatible providers).
  useEffect(() => {
    if (
      model &&
      availableModels.length > 0 &&
      !availableModels.some((m) => m.id === model)
    ) {
      onModelChange("");
    }
  }, [model, availableModels, onModelChange]);

  return (
    <>
      {/* Provider — required. Filtered to providers with at least one
          connection so users can't bind a profile to a non-dispatchable
          route. */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label
            id="profile-editor-provider-label"
            className="block text-body-small-default text-[var(--content-tertiary)]"
          >
            Provider
          </label>
          {providerMissing ? (
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
            label: INFERENCE_PROVIDER_DISPLAY_NAMES[p] ?? p,
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
                        INFERENCE_PROVIDER_DISPLAY_NAMES[provider] ?? provider
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
              label: !provider
                ? "Select a provider first"
                : provider === "openai-compatible" && availableModels.length === 0
                  ? "Configure models on connection"
                  : "Select a model",
            },
            ...availableModels.map((m) => ({
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
            {provider === "openai-compatible" && availableModels.length === 0
              ? "No models available. Configure models on the provider connection first."
              : "Select a model."}
          </Typography>
        ) : null}
      </div>
    </>
  );
}

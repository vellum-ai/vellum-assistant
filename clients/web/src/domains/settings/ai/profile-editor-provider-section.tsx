import { useEffect, useMemo, useState } from "react";

import { useTranslation } from "@/i18n";

import { Button } from "@vellumai/design-library/components/button";
import { Select } from "@vellumai/design-library/components/select";
import { Input } from "@vellumai/design-library/components/input";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  getModelsForProvider,
  PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";

import {
  codexServableModels,
  restrictsToSubscriptionModels,
} from "@/domains/settings/ai/codex-subscription-models";
import {
  CHATGPT_CONNECTION_PROVIDER,
  OPENAI_COMPATIBLE_PROVIDER,
  VELLUM_CONNECTION_PROVIDER,
} from "@/domains/settings/ai/constants";
import {
  entryPickerValue,
  expandEndpointEntries,
  parseEntryPickerValue,
  providersServedByConnections,
  useSelectableCatalogProviders,
} from "@/domains/settings/ai/provider-availability";
import { useActiveAssistantIsSelfHosted } from "@/hooks/use-platform-gate";
import type {
  ConnectionModel,
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

function connectionModelsToCatalog(
  models: ConnectionModel[] | null | undefined,
) {
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
const NO_PROVIDER_CONNECTIONS_HINT =
  "No provider connections. Open Providers to add one.";

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
    hint: "No models are available for this provider in this app version. Update the app, or enter a custom model ID.",
  },
} as const;

/**
 * Sentinel value for the Model dropdown option that switches the field into
 * free-text entry. Namespaced so it can never collide with a real model id.
 */
const CUSTOM_MODEL_OPTION_VALUE = "__custom-model-id__";

/**
 * Right-aligned muted annotation on a provider-picker row: the row answers
 * "whose infrastructure" at the moment of choice (Managed / Custom).
 */
export function PickerMeta({ text }: { text: string }) {
  return (
    <span className="text-body-small-default text-[var(--content-tertiary)]">
      {text}
    </span>
  );
}

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
  /**
   * Why the Provider field blocks Save, or null. Rendered inline: a disabled
   * Save with no explanation is the state this exists to remove.
   */
  providerError?: string | null;
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
  providerError = null,
}: ProfileEditorProviderSectionProps) {
  const providerWithoutModel = provider.length > 0 && model.length === 0;

  // Free-text model entry. Catalog and connection lists can't cover every id a
  // pass-through provider (e.g. OpenRouter) accepts, so the Model field offers
  // an explicit escape hatch: picking the sentinel option swaps the dropdown
  // for a text input whose value is sent to the connection verbatim. It's
  // withheld from subscription-restricted connections, which only accept a
  // fixed model set.
  const { t } = useTranslation("settings");
  const [isEnteringCustomModel, setIsEnteringCustomModel] = useState(false);

  const subscriptionRestricted = restrictsToSubscriptionModels(
    provider,
    providerConnection,
    availableConnectionsForProvider,
  );
  // The chatgpt identity validates models against the Codex set at the
  // schema, so a typed id outside the list could never save.
  const allowsCustomModel =
    provider !== "" &&
    provider !== CHATGPT_CONNECTION_PROVIDER &&
    !subscriptionRestricted;

  // Switching providers reopens the field on the new provider's model list;
  // a connection that bars custom ids also closes the free-text input.
  useEffect(() => {
    if (!allowsCustomModel) {
      setIsEnteringCustomModel(false);
    }
  }, [provider, allowsCustomModel]);

  function handleModelSelection(value: string) {
    if (value === CUSTOM_MODEL_OPTION_VALUE) {
      setIsEnteringCustomModel(true);
      onModelChange("");
      return;
    }
    onModelChange(value);
  }

  const allProvidersForPicker = useSelectableCatalogProviders();
  const activeAssistantIsSelfHosted = useActiveAssistantIsSelfHosted();

  // Providers backed by at least one connection — picking a provider with zero
  // connections binds a profile to a route the daemon can't dispatch through.
  // The Vellum-managed connection expands into every managed-routable provider
  // (see `providersServedByConnections`). The currently-bound `provider` is
  // always kept so editing a stale profile still renders a sensible trigger.
  const visibleProviders = useMemo(() => {
    const served = providersServedByConnections(
      connections ?? [],
      activeAssistantIsSelfHosted,
    );
    if (provider && !served.includes(provider)) {
      return [...served, provider];
    }
    return served;
  }, [connections, provider, activeAssistantIsSelfHosted]);

  // Pre-load fallback: when `connections` is `undefined` the parent hasn't
  // resolved its `listConnections` fetch yet. Fall back to the full catalog
  // so the trigger isn't empty during that gap. An EMPTY-but-loaded
  // `connections === []` is distinct: zero connections confirmed, so the
  // filter runs and yields empty — the empty-state hint fires.
  const providerOptionsSource =
    connections === undefined ? allProvidersForPicker : visibleProviders;

  // A confirmed-empty connection list. Read-only profiles cannot act on it,
  // so they are not told to.
  const noProviderConnections =
    providerOptionsSource.length === 0 && !isReadOnly;

  // A stale openai profile in a workspace whose only OpenAI access is the
  // subscription: nothing can serve it, but the fix is one picker entry
  // away. Covers both row shapes (provider "chatgpt", and the pre-366 rows
  // older daemons still return, where the subscription row stores provider
  // "openai" with oauth_subscription auth).
  const subscriptionSteeringHint =
    provider === "openai" &&
    !isReadOnly &&
    availableConnectionsForProvider.length === 0 &&
    (connections ?? []).some(
      (c) =>
        c.provider === CHATGPT_CONNECTION_PROVIDER ||
        c.auth.type === "oauth_subscription",
    )
      ? t("profileEditor.subscriptionSteeringHint")
      : undefined;

  // For openai-compatible providers the static catalog is empty — use models
  // from the selected connection instead. When no specific connection is
  // selected, merge models from all available openai-compatible connections.
  const availableModels: readonly { id: string; displayName: string }[] =
    useMemo(() => {
      if (!provider) {
        return [];
      }
      const catalogModels = getModelsForProvider(provider);
      if (catalogModels.length > 0) {
        if (
          restrictsToSubscriptionModels(
            provider,
            providerConnection,
            availableConnectionsForProvider,
          )
        ) {
          return codexServableModels(provider);
        }
        return catalogModels;
      }
      // Static catalog is empty (openai-compatible) — derive from connections.
      if (providerConnection) {
        const conn = availableConnectionsForProvider.find(
          (c) => c.name === providerConnection,
        );
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
    }, [provider, providerConnection, availableConnectionsForProvider]);

  // The Model dropdown always offers the profile's currently-bound model, even
  // when it's absent from the static catalog — a profile can be bound (via Chat)
  // to a model this build doesn't list: a new or cloaked provider model, or one
  // carried only on the connection. Label it from the catalog, then connection
  // models, then the raw id.
  const modelOptions: readonly { id: string; displayName: string }[] =
    useMemo(() => {
      if (!model || availableModels.some((m) => m.id === model)) {
        return availableModels;
      }
      const fromCatalog = getModelsForProvider(provider).find(
        (m) => m.id === model,
      );
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
    if (!provider) {
      return;
    }
    // While the user is typing a custom id it won't match the catalog or
    // connection lists — leave it untouched instead of clearing every keystroke.
    if (isEnteringCustomModel) {
      return;
    }
    const catalogModels = getModelsForProvider(provider);
    if (
      catalogModels.length > 0 &&
      !catalogModels.some((m) => m.id === model)
    ) {
      return;
    }
    if (
      model &&
      availableModels.length > 0 &&
      !availableModels.some((m) => m.id === model)
    ) {
      onModelChange("");
    }
  }, [model, availableModels, onModelChange, provider, isEnteringCustomModel]);

  const defaultEntryMetaLabel = t("aiProviderPicker.defaultEntryMeta");

  // Options are computed ahead of the JSX so the trigger value can be
  // membership-checked below: a value with no matching option makes the
  // Select render its placeholder, which reads as an empty picker on a
  // working profile (stale binding among surviving siblings, or a
  // cross-kind binding such as a chatgpt row serving openai).
  const providerOptions = useMemo(() => {
    const base = expandEndpointEntries(
      providerOptionsSource,
      connections ?? [],
      (p) => PROVIDER_DISPLAY_NAMES[p] ?? p,
      defaultEntryMetaLabel,
    ).map(({ value, label, meta }) => ({
      value,
      label,
      suffix: meta ? <PickerMeta text={meta} /> : undefined,
    }));
    // A bound endpoint whose row was deleted still renders on the
    // trigger; the warning below explains the state.
    if (
      connectionNotFound &&
      provider === OPENAI_COMPATIBLE_PROVIDER &&
      providerConnection
    ) {
      base.push({
        value: entryPickerValue(OPENAI_COMPATIBLE_PROVIDER, providerConnection),
        label: `${providerConnection} (not found)`,
        suffix: undefined,
      });
    }
    // An unbound openai-compatible profile has no endpoint entry to
    // select; the bare protocol value keeps the trigger labeled.
    // Picking an endpoint entry from this same list binds it.
    if (provider === OPENAI_COMPATIBLE_PROVIDER && !providerConnection) {
      base.push({
        value: OPENAI_COMPATIBLE_PROVIDER,
        label:
          PROVIDER_DISPLAY_NAMES[OPENAI_COMPATIBLE_PROVIDER] ??
          OPENAI_COMPATIBLE_PROVIDER,
        suffix: undefined,
      });
    }
    return base;
  }, [
    providerOptionsSource,
    connections,
    connectionNotFound,
    provider,
    providerConnection,
    defaultEntryMetaLabel,
  ]);

  const entryValue =
    provider && providerConnection
      ? entryPickerValue(provider, providerConnection)
      : null;
  // A binding to an identity row (a chatgpt row serving openai, a vellum
  // row serving a managed-routable vendor) has no entry option of its own:
  // identity rows never expand. The identity's bare option names the route
  // the profile actually dispatches through, so the trigger shows it
  // rather than the vendor.
  const boundIdentityKind = (() => {
    if (!providerConnection) {
      return null;
    }
    const row = connections?.find((c) => c.name === providerConnection);
    return row &&
      (row.provider === VELLUM_CONNECTION_PROVIDER ||
        row.provider === CHATGPT_CONNECTION_PROVIDER)
      ? row.provider
      : null;
  })();
  const optionExists = (value: string) =>
    providerOptions.some((option) => option.value === value);
  const selectValue =
    entryValue !== null && optionExists(entryValue)
      ? entryValue
      : boundIdentityKind !== null && optionExists(boundIdentityKind)
        ? boundIdentityKind
        : provider;

  return (
    <>
      {/* Provider — required. Filtered to providers with at least one
          connection so users can't bind a profile to a non-dispatchable
          route. Hidden when the parent renders its own provider picker. */}
      {!hideProviderField && (
        <Select
          id="profile-editor-provider"
          label="Provider"
          errorText={
            // With nothing to select, "add a connection" is both the reason
            // Save is blocked and the way out, so it becomes the error.
            // Passing it as helper text would hide it: the field shows one
            // message, and the error wins.
            providerError && noProviderConnections
              ? NO_PROVIDER_CONNECTIONS_HINT
              : providerError
          }
          helperText={
            noProviderConnections && !providerError
              ? NO_PROVIDER_CONNECTIONS_HINT
              : subscriptionSteeringHint
          }
          value={selectValue}
          onChange={(next) => {
            const entry = parseEntryPickerValue(next);
            if (entry) {
              // An entry row implies its kind plus the binding; a same-kind
              // entry switch keeps the model (onProviderChange no-ops).
              onProviderChange(entry.provider);
              onConnectionChange(entry.connectionName);
              return;
            }
            onProviderChange(next as ConnectionProvider);
            // Re-picking the current kind's bare row means "the default
            // entry": the explicit binding must clear, and the provider
            // change above no-ops so it won't do it. A different provider
            // resolves its own binding there instead.
            if (next === provider) {
              onConnectionChange("");
            }
          }}
          disabled={isReadOnly}
          placeholder="Select a provider…"
          options={providerOptions}
        />
      )}

      {/* No binding UI: catalog providers resolve their credential from the
          provider value, and openai-compatible endpoints are their own
          provider-picker entries. A stored reference to a deleted
          credential must still fail loudly: saving clears it and dispatch
          falls back to the provider's available key. */}
      {connectionNotFound && !isReadOnly && (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-(--system-negative-strong)"
        >
          This profile referenced a credential that no longer exists. Saving
          resets it to use the provider&rsquo;s available key.
        </Typography>
      )}

      {/* Model — required once a provider is selected. The dropdown offers the
          provider's known models plus a free-text escape hatch for ids this
          build doesn't list (e.g. a new OpenRouter model). */}
      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          Model
        </label>
        {isEnteringCustomModel ? (
          <>
            <Input
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              disabled={isReadOnly}
              placeholder="provider/model-id"
              aria-label="Custom model ID"
              fullWidth
              autoFocus
            />
            <Button
              variant="link"
              size="compact"
              disabled={isReadOnly}
              onClick={() => setIsEnteringCustomModel(false)}
            >
              Choose from list
            </Button>
          </>
        ) : (
          <Select
            value={model}
            onChange={handleModelSelection}
            disabled={isReadOnly || !provider}
            aria-label="Model"
            // Radix reserves the empty string, and the leading row this used
            // to fake is what `placeholder` is for: an unset field, not a
            // choosable option.
            placeholder={modelEmptyStateCopy?.placeholder ?? "Select a model"}
            options={[
              ...modelOptions.map((m) => ({
                value: m.id,
                label: m.displayName,
              })),
              ...(allowsCustomModel
                ? [
                    {
                      value: CUSTOM_MODEL_OPTION_VALUE,
                      label: "Enter a custom model ID…",
                    },
                  ]
                : []),
            ]}
          />
        )}
        {isEnteringCustomModel ? (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-tertiary)]"
          >
            Enter the exact model identifier your provider expects. It's sent to
            the connection as-is.
          </Typography>
        ) : providerWithoutModel && !isReadOnly ? (
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

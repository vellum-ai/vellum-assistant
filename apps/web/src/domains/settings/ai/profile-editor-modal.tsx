import { useEffect, useMemo, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input, Textarea } from "@vellum/design-library/components/input";
import { Modal } from "@vellum/design-library/components/modal";
import { Tag } from "@vellum/design-library/components/tag";
import { Toggle } from "@vellum/design-library/components/toggle";
import { Typography } from "@vellum/design-library/components/typography";

import {
  getModelsForProvider,
  MODELS_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES as INFERENCE_PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";

import type { ProfileEntry, ProfileWithName } from "@/domains/settings/ai/ai-types";
import {
  ProfileAdvancedParams,
  THINKING_LEVEL_INHERIT,
} from "@/domains/settings/ai/profile-advanced-params";
import { resolveProfileParamVisibility } from "@/domains/settings/ai/profile-param-visibility";
import { type ConnectionModel, type ProviderConnection } from "@/domains/settings/ai/provider-connections-client";
import { useLabelKeySync } from "@/domains/settings/ai/use-label-key-sync";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_PROVIDERS = Object.keys(MODELS_BY_PROVIDER) as (keyof typeof MODELS_BY_PROVIDER)[];
const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";

const CODEX_SUBSCRIPTION_MODEL_IDS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
]);



// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfileStatus = "active" | "disabled";

export interface ProfileEditorModalProps {
  isOpen: boolean;
  mode: "create" | "edit" | "view";
  profileName?: string;
  initialValues?: ProfileWithName;
  existingNames: string[];
  /**
   * Provider connections, supplied by the parent (`ManageProfilesModal`).
   * Used to render the per-provider Connection sub-dropdown and filter the
   * Provider picker to providers with at least one connection.
   *
   * `undefined` vs `[]` is meaningful:
   * - `undefined` → caller has not yet loaded connections (pre-load
   *   window between mount and `listConnections` resolving, or older
   *   callers that don't wire the prop). The Provider picker falls back
   *   to the full catalog so the trigger isn't empty during that gap.
   * - `[]` → caller fetched and got zero connections. The Provider
   *   filter runs and yields empty, the empty-state hint fires, and
   *   the user is steered to Providers instead of picking a provider
   *   the daemon can't dispatch through.
   */
  connections?: ProviderConnection[];
  openAICompatibleEndpointsEnabled?: boolean;
  /**
   * Persist a profile entry. The optional `options.mode` argument tells the
   * parent how to combine `entry` with the existing on-disk record:
   *   - `"replace"` (default for create/edit modes): the parent does a
   *     delete-then-recreate cycle so omitted fields are reset to default.
   *   - `"merge"` (view mode): the parent skips the delete and sends a
   *     single deep-merge PATCH so unspecified fields (provider, model,
   *     advanced params) survive. Required for managed-profile policy
   *     edits — view mode sends only `{label, status}` and we must not
   *     destroy the seed-owned fields.
   */
  onSave: (
    name: string,
    entry: ProfileEntry,
    options?: { mode?: "merge" | "replace" },
  ) => Promise<void>;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// ProfileEditorModal
// ---------------------------------------------------------------------------

export function ProfileEditorModal({
  isOpen,
  mode,
  profileName,
  initialValues,
  existingNames,
  connections,
  openAICompatibleEndpointsEnabled = false,
  onSave,
  onCancel,
}: ProfileEditorModalProps) {
  return (
    <Modal.Root
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      {isOpen ? (
        <ProfileEditorModalInner
          mode={mode}
          profileName={profileName}
          initialValues={initialValues}
          existingNames={existingNames}
          connections={connections}
          openAICompatibleEndpointsEnabled={openAICompatibleEndpointsEnabled}
          onSave={onSave}
          onCancel={onCancel}
        />
      ) : null}
    </Modal.Root>
  );
}

// ---------------------------------------------------------------------------
// ProfileEditorModalInner
// ---------------------------------------------------------------------------

interface ProfileEditorModalInnerProps {
  mode: "create" | "edit" | "view";
  profileName?: string;
  initialValues?: ProfileWithName;
  existingNames: string[];
  // See `ProfileEditorModalProps.connections` for nil-vs-empty semantics.
  connections: ProviderConnection[] | undefined;
  openAICompatibleEndpointsEnabled: boolean;
  onSave: (
    name: string,
    entry: ProfileEntry,
    options?: { mode?: "merge" | "replace" },
  ) => Promise<void>;
  onCancel: () => void;
}

function ProfileEditorModalInner({
  mode,
  profileName,
  initialValues,
  existingNames,
  connections,
  openAICompatibleEndpointsEnabled,
  onSave,
  onCancel,
}: ProfileEditorModalInnerProps) {
  const [effectiveMode, setEffectiveMode] = useState<"create" | "edit" | "view">(mode);
  const isReadOnly = effectiveMode === "view";
  const isAutoProfile = profileName === "auto";

  // Managed profiles open the editor in view mode (mode === "view") so they
  // can't be reshaped (provider, model, advanced params) — those are
  // daemon-seeded. But the user is still allowed to rename them (label)
  // and disable them (status) without leaving view mode, since those two
  // fields are user policy, not daemon contract. The Save button at the
  // footer is gated by `hasViewModeChanges` below so unchanged view-mode
  // sessions stay close-only.
  const initialLabel = initialValues?.label ?? "";
  const initialStatus: ProfileStatus = initialValues?.status ?? "active";

  const [label, setLabel] = useState(initialValues?.label ?? "");
  const [description, setDescription] = useState(
    initialValues?.description ?? "",
  );
  const [key, setKey] = useState(
    mode === "create" ? "" : (profileName ?? ""),
  );
  const [provider, setProvider] = useState(initialValues?.provider ?? "");
  const [model, setModel] = useState(initialValues?.model ?? "");
  // Per-profile provider-connection binding. Empty string means no explicit
  // binding — daemon falls back to its first-connection dispatch. Snake_case
  // `provider_connection` matches the wire schema.
  const [providerConnection, setProviderConnection] = useState(
    initialValues?.provider_connection ?? "",
  );
  const [status, setStatus] = useState<ProfileStatus>(initialValues?.status ?? "active");
  // True when in view mode and the user has touched either of the two
  // fields that view mode permits editing (label, status). Drives the
  // view-mode Save button's enabled state and the partial-update save path.
  const hasViewModeChanges =
    isReadOnly && (label !== initialLabel || status !== initialStatus);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Advanced params — sliders (null = "inherit / not overridden")
  const [maxTokens, setMaxTokens] = useState<number | null>(
    initialValues?.maxTokens ?? null,
  );
  const [contextWindowMaxInputTokens, setContextWindowMaxInputTokens] = useState<number | null>(
    initialValues?.contextWindow?.maxInputTokens ?? null,
  );

  // Advanced params — segment controls
  // effort: "none" is the sentinel for "not overridden"
  const [effort, setEffort] = useState<string>(initialValues?.effort ?? "none");
  // speed: "standard" is the sentinel for "not overridden"
  const [speed, setSpeed] = useState<string>(initialValues?.speed ?? "standard");
  // verbosity: defaults to "medium"; always included when visible
  const [verbosity, setVerbosity] = useState<string>(initialValues?.verbosity ?? "medium");

  // Advanced params — temperature
  const [temperatureEnabled, setTemperatureEnabled] = useState<boolean>(
    typeof initialValues?.temperature === "number",
  );
  const [temperature, setTemperature] = useState<number>(
    typeof initialValues?.temperature === "number" ? initialValues.temperature : 0.7,
  );

  // Advanced params — thinking
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(
    initialValues?.thinking?.enabled ?? false,
  );
  const [thinkingStreamThinking, setThinkingStreamThinking] = useState<boolean>(
    initialValues?.thinking?.streamThinking ?? false,
  );
  // Gemini reasoning-depth knob. "default" = inherit the model default.
  const [thinkingLevel, setThinkingLevel] = useState<string>(
    initialValues?.thinking?.level ?? THINKING_LEVEL_INHERIT,
  );

  // Derived: selected model from catalog
  const selectedModel = useMemo(
    () => (provider ? getModelsForProvider(provider).find((m) => m.id === model) ?? null : null),
    [provider, model],
  );

  // Derived: which advanced param fields to show
  const visibility = useMemo(
    () => resolveProfileParamVisibility(provider, model),
    [provider, model],
  );

  const allProvidersForPicker = useMemo(
    () =>
      openAICompatibleEndpointsEnabled
        ? ALL_PROVIDERS
        : ALL_PROVIDERS.filter((p) => p !== OPENAI_COMPATIBLE_PROVIDER),
    [openAICompatibleEndpointsEnabled],
  );

  // Derived: connections matching the currently selected provider. During
  // pre-load (`connections === undefined`) there's nothing to pick — the
  // Connection sub-dropdown stays hidden until the fetch resolves. Mirrors
  // macOS `availableConnectionsForProvider` filter.
  const availableConnectionsForProvider = useMemo(
    () =>
      provider
        ? (connections ?? []).filter(
            (c) =>
              c.provider === provider &&
              (openAICompatibleEndpointsEnabled ||
                c.provider !== OPENAI_COMPATIBLE_PROVIDER),
          )
        : [],
    [provider, connections, openAICompatibleEndpointsEnabled],
  );

  // Derived: providers to show in the Provider dropdown. Filter to only
  // providers with at least one connection — picking a provider with
  // zero connections binds a profile to a route the daemon can't
  // dispatch through, leaving the user stuck. The currently-bound `provider`
  // is always kept in the list so editing/viewing a stale profile (whose
  // connection was deleted after the binding was saved) still renders
  // a sensible trigger.
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

  // Pre-load fallback: when `connections` is `undefined` the parent has not
  // yet resolved its `listConnections` fetch (or never wires the prop at
  // all). Fall back to the full catalog so the trigger isn't empty during
  // that gap. An EMPTY-but-loaded `connections === []` is distinct: the
  // caller confirmed zero connections, so the filter runs and yields empty
  // — the empty-state hint below fires and steers the user to Providers
  // instead of letting them save a profile bound to a non-dispatchable
  // provider. Mirrors the macOS `availableProviderIds` filter.
  const providerOptionsSource =
    connections === undefined ? allProvidersForPicker : visibleProviders;

  // Derived: saved binding no longer points at any known connection. Either
  // the connection was deleted out from under the profile. We surface a
  // warning AND auto-clear the binding on save so the user can re-pick
  // rather than silently re-persisting a broken binding. Mirrors macOS "Not
  // found" badge — and goes one step further by ensuring the stale value
  // doesn't survive an opens-and-saves round-trip.
  const connectionNotFound =
    providerConnection !== "" &&
    !availableConnectionsForProvider.some((c) => c.name === providerConnection);

  // Show the Connection field whenever there's something meaningful to show:
  //  - matching connections to pick from, OR
  //  - a non-empty saved binding (so the user can see + clear stale state).
  // Otherwise hide — there's nothing for the user to act on. Provider must
  // be selected; without it we can't filter or label.
  const showConnectionField =
    provider !== "" &&
    (availableConnectionsForProvider.length > 0 ||
      providerConnection !== "");

  const { handleLabelChange, handleKeyChange, resetDirty } =
    useLabelKeySync(effectiveMode, setLabel, setKey);

  // Reset dirty tracking when modal re-opens with new values.
  useEffect(() => {
    resetDirty();
  }, [profileName, mode, resetDirty]);

  function handleProviderChange(newProvider: string) {
    // Guard: re-selecting the same provider is a no-op — don't clear fields
    if (newProvider === provider) return;
    setProvider(newProvider);
    setModel("");
    // Auto-select connection: if exactly one connection exists for the new
    // provider, select it automatically. If multiple exist, clear so the user
    // must pick. If zero, clear.
    const connectionsForProvider = (connections ?? []).filter(
      (c) => c.provider === newProvider,
    );
    setProviderConnection(
      connectionsForProvider.length === 1
        ? connectionsForProvider[0].name
        : "",
    );
    // Reset all advanced params when provider changes
    setMaxTokens(null);
    setContextWindowMaxInputTokens(null);
    setEffort("none");
    setSpeed("standard");
    setVerbosity("medium");
    setTemperatureEnabled(false);
    setTemperature(0.7);
    setThinkingEnabled(false);
    setThinkingStreamThinking(false);
    setThinkingLevel(THINKING_LEVEL_INHERIT);
  }

  function handleConnectionChange(newConnection: string) {
    setProviderConnection(newConnection);
    // For providers with per-connection models (openai-compatible), clear the
    // selected model when switching connections if it's not in the new list.
    if (provider && getModelsForProvider(provider).length === 0 && model) {
      const conn = availableConnectionsForProvider.find((c) => c.name === newConnection);
      const connModelIds = new Set((conn?.models ?? []).map((m) => m.id));
      if (newConnection === "" || !connModelIds.has(model)) {
        setModel("");
      }
    }
  }

  function handleModelChange(newModel: string) {
    // Guard: re-selecting the same model is a no-op — don't clear token overrides
    if (newModel === model) return;
    setModel(newModel);
    // Reset token sliders when model changes — different models have different limits
    setMaxTokens(null);
    setContextWindowMaxInputTokens(null);
  }

  // Validation
  const keyTrimmed = key.trim();
  const keyEmpty = keyTrimmed.length === 0;
  const keyHasWhitespace = /\s/.test(key);
  const keyNotUnique =
    effectiveMode === "create"
      ? existingNames.includes(keyTrimmed)
      : existingNames.filter((n) => n !== profileName).includes(keyTrimmed);
  const providerMissing = provider.length === 0;
  const providerWithoutModel = provider.length > 0 && model.length === 0;

  const isInvalid =
    keyEmpty ||
    keyHasWhitespace ||
    keyNotUnique ||
    providerMissing ||
    providerWithoutModel;

  const keyError = keyEmpty
    ? "Key is required"
    : keyHasWhitespace
      ? "Key cannot contain whitespace"
      : keyNotUnique
        ? "A profile with this key already exists"
        : null;

  async function handleSave() {
    if (isInvalid && !isReadOnly) return;
    // View mode is reserved for managed profiles. The user can rename them
    // (label) and disable them (status) without leaving view mode, but
    // everything else (provider, model, advanced params, binding) belongs
    // to the daemon seed and must NOT be in the request body — the daemon
    // would reject the request as a managed-profile mutation otherwise.
    //
    // `mode: "merge"` tells the parent to skip its delete-then-recreate
    // cycle and send a single deep-merge PATCH. Without this, the seed
    // fields (provider, model, advanced params) would be destroyed by
    // the recreate step that only writes back the partial `{label, status}`
    // entry.
    if (isReadOnly) {
      if (!hasViewModeChanges) return;
      setSaving(true);
      setSaveError(null);
      try {
        const entry: ProfileEntry = {
          label: label.trim() || null,
          status,
        };
        await onSave(keyTrimmed, entry, { mode: "merge" });
      } catch {
        setSaveError("Failed to save profile. Please try again.");
      } finally {
        setSaving(false);
      }
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const entry: ProfileEntry = {};
      // Stale bindings are auto-cleared on save: if the saved
      // provider_connection doesn't match any known connection for the
      // current provider, treat it as cleared instead of silently
      // re-persisting the broken binding. When providerConnection is
      // empty and there's exactly one available connection, resolve to
      // that connection's name so profiles always persist with an
      // explicit binding.
      const resolvedBinding =
        providerConnection === "" && availableConnectionsForProvider.length === 1
          ? availableConnectionsForProvider[0].name
          : providerConnection;
      const effectiveBinding = connectionNotFound ? "" : resolvedBinding;
      if (effectiveMode === "edit") {
        // In edit mode send null for cleared fields so the server deep-merges
        // them as cleared rather than silently preserving the old value.
        entry.label = label.trim() || null;
        entry.description = description.trim() || null;
        entry.provider = provider || null;
        entry.model = model || null;
        entry.provider_connection = effectiveBinding || null;
      } else {
        // In create mode omit optional fields that are still empty.
        if (label.trim()) entry.label = label.trim();
        if (description.trim()) entry.description = description.trim();
        if (provider) entry.provider = provider;
        if (model) entry.model = model;
        if (effectiveBinding) entry.provider_connection = effectiveBinding;
      }
      // Advanced params
      if (visibility.maxTokens && maxTokens !== null) {
        entry.maxTokens = maxTokens;
      }
      if (visibility.contextWindow && contextWindowMaxInputTokens !== null) {
        entry.contextWindow = { maxInputTokens: contextWindowMaxInputTokens };
      }
      if (visibility.effort && effort !== "none") {
        entry.effort = effort;
      }
      if (visibility.speed && speed !== "standard") {
        entry.speed = speed;
      }
      if (visibility.verbosity) {
        entry.verbosity = verbosity;
      }
      if (visibility.temperature) {
        if (temperatureEnabled) {
          entry.temperature = temperature;
        } else if (effectiveMode === "edit") {
          entry.temperature = null;
        }
        // create mode + toggle off → omit
      }
      if (visibility.thinking) {
        entry.thinking = {
          enabled: thinkingEnabled,
          ...(thinkingEnabled ? { streamThinking: thinkingStreamThinking } : {}),
        };
      }
      // Gemini: a chosen level implies thinking is on; "default" omits the
      // field so the daemon applies the model default.
      if (visibility.thinkingLevel && thinkingLevel !== THINKING_LEVEL_INHERIT) {
        entry.thinking = { enabled: true, level: thinkingLevel };
      }
      // Status — always include in edit mode; omit in create when active (default)
      if (effectiveMode === "edit") {
        entry.status = status;
      } else if (status !== "active") {
        entry.status = status;
      }
      // Do NOT include source or name
      await onSave(keyTrimmed, entry);
    } catch {
      setSaveError("Failed to save profile. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const modalTitle =
    effectiveMode === "create"
      ? "New Profile"
      : effectiveMode === "edit"
        ? "Edit Profile"
        : (initialValues?.label ?? profileName ?? "Profile");

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

  useEffect(() => {
    if (
      model &&
      availableModels.length > 0 &&
      !availableModels.some((m) => m.id === model)
    ) {
      setModel("");
    }
  }, [model, availableModels]);

  return (
    <Modal.Content size="md">
      <Modal.Header>
        {effectiveMode === "view" ? (
          <div className="flex items-center gap-2">
            <Modal.Title>{modalTitle}</Modal.Title>
            <Tag tone="positive">Platform</Tag>
          </div>
        ) : (
          <Modal.Title>{modalTitle}</Modal.Title>
        )}
      </Modal.Header>

      <Modal.Body>
        <div className="space-y-4">
          {/* Display Name — editable in all modes, including view (managed
              profiles can be renamed without leaving view mode; everything
              else stays locked). */}
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Display Name
            </label>
            <Input
              type="text"
              value={label}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder="e.g. Fast & Cheap"
              fullWidth
            />
          </div>

          {/* Description */}
          <Textarea
            label={
              <>
                Description{" "}
                <span className="text-[var(--content-disabled)]">(optional)</span>
              </>
            }
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe when to use this profile"
            disabled={isReadOnly}
            rows={2}
            fullWidth
            className="resize-none"
          />

          {/* Key */}
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Key
            </label>
            <Input
              type="text"
              value={key}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder="e.g. fast-cheap"
              disabled={isReadOnly || effectiveMode === "edit"}
              fullWidth
            />
            {keyError && !isReadOnly ? (
              <Typography
                variant="body-small-default"
                as="p"
                className="text-(--system-negative-strong)"
              >
                {keyError}
              </Typography>
            ) : null}
          </div>

          {/* Status — editable in all modes, including view. Same rationale
              as Display Name: status is user policy, not daemon contract,
              so view-mode-on-managed still allows disabling. */}
          <Toggle
            checked={status === "active"}
            onChange={(v) => setStatus(v ? "active" : "disabled")}
            label="Active"
          />

          {isAutoProfile && (
            <div className="rounded-lg bg-[var(--surface-info-subtle)] p-3">
              <p className="text-body-small-default text-[var(--content-secondary)]">
                Auto mode routes each query to the best profile automatically
                — fast for simple questions, capable for complex ones. No
                provider or model configuration needed.
              </p>
            </div>
          )}

          {/* Provider, Connection, Model, and advanced params are hidden for
              the "auto" meta-profile which has no provider/model of its own. */}
          {!isAutoProfile && <>
          {/* Provider — required. The old "None (inherits defaults)" option
              was removed because the inherit pathway encouraged accidental
              fallbacks to the global default model, defeating the point of
              named profiles. The picker is filtered to providers with at
              least one connection (see `visibleProviders` above) so
              users can't bind a profile to a route the daemon can't
              dispatch through. */}
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
              onChange={handleProviderChange}
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

          {/* Connection — visible when (a) connections match the
              selected provider, OR (b) a non-empty saved binding exists
              (even if stale, so the user can see + clear it). Hidden
              otherwise. Provider must be selected. */}
          {showConnectionField && (
            <div className="space-y-1">
              <label className="block text-body-small-default text-[var(--content-tertiary)]">
                Connection{" "}
                <span className="text-[var(--content-disabled)]">(optional)</span>
              </label>
              <Dropdown
                value={providerConnection}
                onChange={handleConnectionChange}
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
                  // Include the stale binding as an explicit (disabled-look)
                  // option so the trigger renders its name. The accompanying
                  // warning below explains the state. On save, stale bindings
                  // are auto-cleared regardless.
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

          {/* Model — required once a provider is selected. The picker only
              renders enabled after a provider is chosen, and `providerWithoutModel`
              blocks save until a model is picked. */}
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Model
            </label>
            <Dropdown
              value={model}
              onChange={handleModelChange}
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
          </>}

          {/* Advanced params — hidden for the auto meta-profile */}
          {!isAutoProfile && (
            <ProfileAdvancedParams
              visibility={visibility}
              isReadOnly={isReadOnly}
              model={model}
              selectedModel={selectedModel}
              maxTokens={maxTokens}
              onMaxTokensChange={setMaxTokens}
              contextWindowMaxInputTokens={contextWindowMaxInputTokens}
              onContextWindowChange={setContextWindowMaxInputTokens}
              effort={effort}
              onEffortChange={setEffort}
              speed={speed}
              onSpeedChange={setSpeed}
              verbosity={verbosity}
              onVerbosityChange={setVerbosity}
              temperatureEnabled={temperatureEnabled}
              onTemperatureEnabledChange={setTemperatureEnabled}
              temperature={temperature}
              onTemperatureChange={setTemperature}
              thinkingEnabled={thinkingEnabled}
              onThinkingEnabledChange={setThinkingEnabled}
              thinkingStreamThinking={thinkingStreamThinking}
              onThinkingStreamThinkingChange={setThinkingStreamThinking}
              thinkingLevel={thinkingLevel}
              onThinkingLevelChange={setThinkingLevel}
            />
          )}

          {/* Save error */}
          {saveError ? (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-(--system-negative-strong)"
            >
              {saveError}
            </Typography>
          ) : null}
        </div>
      </Modal.Body>

      <Modal.Footer>
        {effectiveMode === "view" ? (
          <>
            <Button variant="outlined" onClick={onCancel} disabled={saving} data-testid="modal-cancel-btn">
              Close
            </Button>
            {!isAutoProfile && (
            <Button
              variant="outlined"
              onClick={() => {
                setEffectiveMode("create");
                setKey("");
                resetDirty();
              }}
              disabled={saving}
            >
              Save As New
            </Button>
            )}
            {/* Save in view mode persists ONLY label and status changes
                (managed profile policy fields). The button is gated by
                `hasViewModeChanges` so an unchanged view session can't
                round-trip a no-op write. */}
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={!hasViewModeChanges || saving}
              data-testid="modal-save-btn"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outlined" onClick={onCancel} disabled={saving} data-testid="modal-cancel-btn">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={isInvalid || saving}
              data-testid="modal-save-btn"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal.Content>
  );
}

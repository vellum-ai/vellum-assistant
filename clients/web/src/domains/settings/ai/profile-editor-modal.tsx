import { useEffect, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input, Textarea } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { Tag } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { Typography } from "@vellumai/design-library/components/typography";
import { ChevronRight } from "lucide-react";

import {
  getModelsForProvider,
  PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";
import {
  configGetOptions,
  inferenceProviderconnectionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

import type {
  ProfileEntry,
  ProfilePatchEntry,
  ProfileStatus,
} from "@/generated/daemon/types.gen";

import type { ProfileWithName } from "@/domains/settings/ai/utils";
import {
  ProfileAdvancedParams,
  THINKING_LEVEL_INHERIT,
} from "@/domains/settings/ai/profile-advanced-params";
import { ProfileEditorProviderSection } from "@/domains/settings/ai/profile-editor-provider-section";
import {
  type GeminiThinkingLevel,
  isGeminiThinkingLevel,
  resolveProfileParamVisibility,
} from "@/domains/settings/ai/profile-param-visibility";
import { deriveProfileDefaults } from "@/domains/settings/ai/profile-prefill";
import type {
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import { ProviderCreateForm } from "@/domains/settings/ai/provider-create-form";
import { useLabelKeySync } from "@/domains/settings/ai/use-label-key-sync";

// Sentinel value for the "+ Create new provider" option in the create-mode
// Provider dropdown. Picking it mounts the inline ProviderCreateForm instead
// of selecting a provider.
const CREATE_NEW_PROVIDER_SENTINEL = "__create_new_provider__";
type EffortSelection = "inherit" | NonNullable<ProfileEntry["effort"]>;

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
  /**
   * Assistant whose provider connections the inline "+ Create new provider"
   * sub-form writes to. Required for the create-mode quick-add flow.
   */
  assistantId: string;
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
    entry: ProfilePatchEntry,
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
  assistantId,
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
          assistantId={assistantId}
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
  assistantId: string;
  onSave: (
    name: string,
    entry: ProfilePatchEntry,
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
  assistantId,
  onSave,
  onCancel,
}: ProfileEditorModalInnerProps) {
  const [effectiveMode, setEffectiveMode] = useState<
    "create" | "edit" | "view"
  >(mode);
  const isReadOnly = effectiveMode === "view";

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
  const [key, setKey] = useState(mode === "create" ? "" : (profileName ?? ""));
  const [provider, setProvider] = useState<
    NonNullable<ProfileEntry["provider"]> | ""
  >(initialValues?.provider ?? "");
  const [model, setModel] = useState(initialValues?.model ?? "");
  // Per-profile provider-connection binding. Empty string means no explicit
  // binding — daemon falls back to its first-connection dispatch. Snake_case
  // `provider_connection` matches the wire schema.
  const [providerConnection, setProviderConnection] = useState(
    initialValues?.provider_connection ?? "",
  );
  const [status, setStatus] = useState<ProfileStatus>(
    initialValues?.status ?? "active",
  );
  // Connections created inline this session, before the parent's `connections`
  // prop has refetched. Unioned into the available-connections set so a
  // just-created binding is treated as valid immediately — otherwise
  // `connectionNotFound` would stay true during the parent refetch window and
  // `handleSave` would persist an empty `provider_connection` (the binding the
  // user just created + selected would be silently dropped).
  const [locallyCreatedConnections, setLocallyCreatedConnections] = useState<
    ProviderConnection[]
  >([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Advanced params — sliders (null = "inherit / not overridden")
  const [maxTokens, setMaxTokens] = useState<number | null>(
    initialValues?.maxTokens ?? null,
  );
  const [contextWindowMaxInputTokens, setContextWindowMaxInputTokens] =
    useState<number | null>(
      initialValues?.contextWindow?.maxInputTokens ?? null,
    );

  // Advanced params — segment controls
  const [effort, setEffort] = useState<EffortSelection>(
    initialValues?.effort ?? "inherit",
  );
  // speed: "standard" is the sentinel for "not overridden"
  const [speed, setSpeed] = useState<NonNullable<ProfileEntry["speed"]>>(
    initialValues?.speed ?? "standard",
  );
  // verbosity: defaults to "medium"; always included when visible
  const [verbosity, setVerbosity] = useState<
    NonNullable<ProfileEntry["verbosity"]>
  >(initialValues?.verbosity ?? "medium");

  // Advanced params — temperature
  const [temperatureEnabled, setTemperatureEnabled] = useState<boolean>(
    typeof initialValues?.temperature === "number",
  );
  const [temperature, setTemperature] = useState<number>(
    typeof initialValues?.temperature === "number"
      ? initialValues.temperature
      : 0.7,
  );

  // Advanced params — top P. Top P is editable in view mode (managed
  // profiles), so capture its initial enabled flag + value as the baseline
  // `hasViewModeChanges` compares against.
  const initialTopPEnabled = typeof initialValues?.topP === "number";
  const initialTopP =
    typeof initialValues?.topP === "number" ? initialValues.topP : 0.95;
  const [topPEnabled, setTopPEnabled] = useState<boolean>(initialTopPEnabled);
  const [topP, setTopP] = useState<number>(initialTopP);

  // True when in view mode and the user has touched one of the fields that
  // view mode permits editing (label, status, Top P). Drives the view-mode
  // Save button's enabled state and the partial-update save path. Top P is
  // compared on both the enabled flag and the value so flipping the toggle or
  // dragging the slider both arm Save.
  const hasViewModeChanges =
    isReadOnly &&
    (label !== initialLabel ||
      status !== initialStatus ||
      topPEnabled !== initialTopPEnabled ||
      (topPEnabled && topP !== initialTopP));

  // Advanced params — thinking
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(
    initialValues?.thinking?.enabled ?? false,
  );
  const [thinkingStreamThinking, setThinkingStreamThinking] = useState<boolean>(
    initialValues?.thinking?.streamThinking ?? false,
  );
  // Gemini reasoning-depth knob. "default" = inherit the model default.
  const [thinkingLevel, setThinkingLevel] = useState<
    GeminiThinkingLevel | typeof THINKING_LEVEL_INHERIT
  >(
    isGeminiThinkingLevel(initialValues?.thinking?.level)
      ? initialValues.thinking.level
      : THINKING_LEVEL_INHERIT,
  );

  // Derived: selected model from catalog
  const selectedModel = useMemo(
    () =>
      provider
        ? (getModelsForProvider(provider).find((m) => m.id === model) ?? null)
        : null,
    [provider, model],
  );

  // The advanced-param defaults a profile inherits when it omits an override
  // live on `llm.default`, not on the profile fragment the editor edits. Read
  // them from the loaded config (shared cache with ManageProfilesModal) so the
  // Max Output / Context Window fields advertise the value the daemon will
  // actually resolve, falling back to the schema defaults when unset.
  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  const defaultMaxOutputTokens = config?.llm?.default?.maxTokens;
  const defaultContextWindowMaxInputTokens =
    config?.llm?.default?.contextWindow?.maxInputTokens;

  // Derived: which advanced param fields to show
  const visibility = useMemo(
    () => resolveProfileParamVisibility(provider, model),
    [provider, model],
  );

  // Parent-supplied connections unioned with any created inline this session
  // (deduped by name, prop wins). Drives the Connection sub-dropdown and the
  // save handler's binding resolution so an inline-created connection counts
  // as valid before the parent refetch lands.
  const effectiveConnections = useMemo(() => {
    const base = connections ?? [];
    if (locallyCreatedConnections.length === 0) return base;
    const known = new Set(base.map((c) => c.name));
    return [
      ...base,
      ...locallyCreatedConnections.filter((c) => !known.has(c.name)),
    ];
  }, [connections, locallyCreatedConnections]);

  // Connections matching the currently selected provider. Also used by
  // the save handler for binding resolution.
  const availableConnectionsForProvider = useMemo(
    () =>
      provider
        ? effectiveConnections.filter((c) => c.provider === provider)
        : [],
    [provider, effectiveConnections],
  );

  // Saved binding no longer points at any known connection. The save handler
  // auto-clears it; the provider section surfaces a warning to the user.
  const connectionNotFound =
    providerConnection !== "" &&
    !availableConnectionsForProvider.some((c) => c.name === providerConnection);

  const { handleLabelChange, handleKeyChange, resetDirty, getDirty } =
    useLabelKeySync(effectiveMode, setLabel, setKey);

  const queryClient = useQueryClient();

  // Create-mode-only UI: whether the inline "+ Create new provider" sub-form
  // is mounted, and whether the advanced-params disclosure is expanded.
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  // One-time helper note shown after an inline provider create succeeds.
  const [newProviderNote, setNewProviderNote] = useState(false);

  // Reset dirty tracking when modal re-opens with new values.
  useEffect(() => {
    resetDirty();
    setCreatingProvider(false);
    setAdvancedExpanded(false);
    setNewProviderNote(false);
    setLocallyCreatedConnections([]);
  }, [profileName, mode, resetDirty]);

  function handleProviderChange(newProvider: ConnectionProvider) {
    if (newProvider === provider) return;
    setProvider(newProvider);
    setModel("");
    // Auto-select connection: if exactly one connection exists for the new
    // provider, select it automatically. If multiple exist, clear so the user
    // must pick. If zero, clear.
    const connectionsForProvider = effectiveConnections.filter(
      (c) => c.provider === newProvider,
    );
    setProviderConnection(
      connectionsForProvider.length === 1 ? connectionsForProvider[0].name : "",
    );
    // Reset all advanced params when provider changes
    setMaxTokens(null);
    setContextWindowMaxInputTokens(null);
    setEffort("inherit");
    setSpeed("standard");
    setVerbosity("medium");
    setTemperatureEnabled(false);
    setTemperature(0.7);
    setTopPEnabled(false);
    setTopP(0.95);
    setThinkingEnabled(false);
    setThinkingStreamThinking(false);
    setThinkingLevel(THINKING_LEVEL_INHERIT);
  }

  function handleConnectionChange(newConnection: string) {
    setProviderConnection(newConnection);
    // For providers with per-connection models (openai-compatible), clear the
    // selected model when switching connections if it's not in the new list.
    if (provider && getModelsForProvider(provider).length === 0 && model) {
      if (newConnection === "") {
        // "Any connection" — merge models from all connections and keep the
        // model if it exists in the merged set.
        const allModelIds = new Set(
          availableConnectionsForProvider.flatMap((c) =>
            (c.models ?? []).map((m) => m.id),
          ),
        );
        if (!allModelIds.has(model)) setModel("");
      } else {
        const conn = availableConnectionsForProvider.find(
          (c) => c.name === newConnection,
        );
        const connModelIds = new Set((conn?.models ?? []).map((m) => m.id));
        if (!connModelIds.has(model)) setModel("");
      }
    }
  }

  // Resolve a model id to its human-facing display name. The static catalog
  // covers first-party providers; openai-compatible models live on the
  // connection, so fall back to those and finally to the id itself.
  function resolveModelDisplayName(modelId: string): string {
    const catalogMatch = getModelsForProvider(provider).find(
      (m) => m.id === modelId,
    );
    if (catalogMatch) return catalogMatch.displayName;
    for (const conn of availableConnectionsForProvider) {
      const match = (conn.models ?? []).find((m) => m.id === modelId);
      if (match) return match.displayName ?? match.id;
    }
    return modelId;
  }

  function handleModelChange(newModel: string) {
    if (newModel === model) return;
    setModel(newModel);
    // Reset token sliders when model changes
    setMaxTokens(null);
    setContextWindowMaxInputTokens(null);
    // Create-mode pre-fill: seed Name + Key from the model's display name,
    // but only while the user hasn't manually edited either field (dirty
    // tracking lives in useLabelKeySync). Clearing the model leaves the
    // current values untouched.
    if (effectiveMode === "create" && newModel && !getDirty()) {
      const { name, key: derivedKey } = deriveProfileDefaults(
        resolveModelDisplayName(newModel),
        existingNames,
      );
      setLabel(name);
      setKey(derivedKey);
    }
  }

  // Inline provider create: bind the new connection as this profile's
  // provider + connection, collapse the sub-form, surface the helper note,
  // and invalidate the connections query so the dropdown picks up the row.
  function handleProviderCreated(connection: ProviderConnection) {
    // Optimistically register the new connection locally so the binding is
    // valid immediately (the parent `connections` refetch below is async).
    setLocallyCreatedConnections((prev) =>
      prev.some((c) => c.name === connection.name)
        ? prev
        : [...prev, connection],
    );
    setProvider(connection.provider);
    setProviderConnection(connection.name);
    setModel("");
    setCreatingProvider(false);
    setNewProviderNote(true);
    void queryClient.invalidateQueries({
      queryKey: inferenceProviderconnectionsGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
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
        // Top P is the one advanced param managed profiles may override.
        // Mirror the create/edit build-entry logic: enabled → number,
        // cleared → null. Only when the selected provider/model surfaces the
        // control. `mode: "merge"` means sending just this changed subset
        // leaves the seed-owned fields intact.
        if (visibility.topP) {
          entry.topP = topPEnabled ? topP : null;
        }
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
      const entry: ProfilePatchEntry = {};
      // Stale bindings are auto-cleared on save: if the saved
      // provider_connection doesn't match any known connection for the
      // current provider, treat it as cleared instead of silently
      // re-persisting the broken binding. When providerConnection is
      // empty and there's exactly one available connection, resolve to
      // that connection's name so profiles always persist with an
      // explicit binding.
      const resolvedBinding =
        providerConnection === "" &&
        availableConnectionsForProvider.length === 1
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
      if (visibility.effort && effort !== "inherit") {
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
      if (visibility.topP) {
        if (topPEnabled) {
          entry.topP = topP;
        } else if (effectiveMode === "edit") {
          entry.topP = null;
        }
        // create mode + toggle off → omit
      }
      if (visibility.thinking) {
        entry.thinking = {
          enabled: thinkingEnabled,
          ...(thinkingEnabled
            ? { streamThinking: thinkingStreamThinking }
            : {}),
        };
      }
      // Gemini: a chosen level implies thinking is on; "default" omits the
      // field so the daemon applies the model default.
      if (
        visibility.thinkingLevel &&
        thinkingLevel !== THINKING_LEVEL_INHERIT
      ) {
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

  // Create mode uses the provider-first layout (Provider -> Model -> Name ->
  // Key -> Description -> collapsed Advanced) with pre-fill. Edit and view
  // modes use the legacy layout below.
  const useProviderFirst = effectiveMode === "create";

  // ---- Reusable field nodes (shared by create + edit/view bodies) ----

  const displayNameField = (
    <div className="space-y-1">
      <label className="block text-body-small-default text-[var(--content-tertiary)]">
        {useProviderFirst ? "Name" : "Display Name"}
      </label>
      <Input
        type="text"
        value={label}
        onChange={(e) => handleLabelChange(e.target.value)}
        placeholder="e.g. Fast & Cheap"
        fullWidth
      />
    </div>
  );

  const descriptionField = (
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
  );

  const keyField = (
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
  );

  const activeToggle = (
    <Toggle
      checked={status === "active"}
      onChange={(v) => setStatus(v ? "active" : "disabled")}
      label="Active"
    />
  );

  const advancedParamsNode = (
    <ProfileAdvancedParams
      visibility={visibility}
      isReadOnly={isReadOnly}
      // Top P is user policy on managed profiles too, so it stays editable in
      // view mode while the other advanced params remain locked by isReadOnly.
      topPReadOnly={false}
      model={model}
      selectedModel={selectedModel}
      defaultMaxOutputTokens={defaultMaxOutputTokens}
      defaultContextWindowMaxInputTokens={defaultContextWindowMaxInputTokens}
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
      topPEnabled={topPEnabled}
      onTopPEnabledChange={setTopPEnabled}
      topP={topP}
      onTopPChange={setTopP}
      thinkingEnabled={thinkingEnabled}
      onThinkingEnabledChange={setThinkingEnabled}
      thinkingStreamThinking={thinkingStreamThinking}
      onThinkingStreamThinkingChange={setThinkingStreamThinking}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={setThinkingLevel}
    />
  );

  const saveErrorNode = saveError ? (
    <Typography
      variant="body-small-default"
      as="p"
      className="text-(--system-negative-strong)"
    >
      {saveError}
    </Typography>
  ) : null;

  // ---- Create-mode-only: provider-first picker with inline create ----

  // Providers with at least one connection, plus the always-present "+ Create
  // new provider" sentinel. First-run empty state shows ONLY the sentinel.
  const createModeProviderOptions = useMemo(() => {
    const seen = new Set<ConnectionProvider>();
    const opts: {
      value: ConnectionProvider | typeof CREATE_NEW_PROVIDER_SENTINEL;
      label: string;
    }[] = [];
    for (const c of effectiveConnections) {
      if (!seen.has(c.provider)) {
        seen.add(c.provider);
        opts.push({
          value: c.provider,
          label: PROVIDER_DISPLAY_NAMES[c.provider] ?? c.provider,
        });
      }
    }
    opts.push({
      value: CREATE_NEW_PROVIDER_SENTINEL,
      label: "+ Create new provider",
    });
    return opts;
  }, [effectiveConnections]);

  const createProviderSection = (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label
            id="profile-editor-provider-label"
            className="block text-body-small-default text-[var(--content-tertiary)]"
          >
            Provider
          </label>
          {providerMissing && !creatingProvider ? (
            <span className="rounded-full bg-[var(--surface-warning-subtle)] px-2 py-0.5 text-body-small-default text-[var(--content-warning)]">
              Pick a provider
            </span>
          ) : null}
        </div>
        <Dropdown
          value={creatingProvider ? CREATE_NEW_PROVIDER_SENTINEL : provider}
          onChange={(next) => {
            if (next === CREATE_NEW_PROVIDER_SENTINEL) {
              setCreatingProvider(true);
              setNewProviderNote(false);
              return;
            }
            if (!next) return;
            setCreatingProvider(false);
            handleProviderChange(next);
          }}
          placeholder="Select a provider…"
          aria-labelledby="profile-editor-provider-label"
          options={createModeProviderOptions}
        />
        {newProviderNote ? (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-tertiary)]"
          >
            New provider connection will show up in the Providers section.
          </Typography>
        ) : null}
      </div>

      {creatingProvider ? (
        <ProviderCreateForm
          variant="inline"
          assistantId={assistantId}
          existingNames={effectiveConnections.map((c) => c.name)}
          defaultProviderType={provider || undefined}
          onCreated={handleProviderCreated}
          onCancel={() => setCreatingProvider(false)}
        />
      ) : (
        <ProfileEditorProviderSection
          provider={provider}
          model={model}
          providerConnection={providerConnection}
          onProviderChange={handleProviderChange}
          onModelChange={handleModelChange}
          onConnectionChange={handleConnectionChange}
          connections={effectiveConnections}
          isReadOnly={isReadOnly}
          availableConnectionsForProvider={availableConnectionsForProvider}
          connectionNotFound={connectionNotFound}
          hideProviderField
        />
      )}
    </div>
  );

  // Only surface Advanced once a model is chosen — the advanced params are
  // model-dependent (effort/thinking/token ranges resolve from the selected
  // model), so showing the disclosure before then is meaningless.
  const createAdvancedDisclosure =
    model !== "" ? (
      <div>
        <button
          type="button"
          aria-expanded={advancedExpanded}
          onClick={() => setAdvancedExpanded((v) => !v)}
          className="flex items-center gap-1 text-body-small-default text-[var(--content-secondary)] w-full text-left"
        >
          <ChevronRight
            className={`h-4 w-4 transition-transform ${advancedExpanded ? "rotate-90" : ""}`}
          />
          <span>Advanced</span>
        </button>
        {advancedExpanded ? (
          <div className="mt-4">{advancedParamsNode}</div>
        ) : null}
      </div>
    ) : null;

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
        {useProviderFirst ? (
          // Create mode is provider-first: Provider (with inline create) ->
          // Model -> Name -> Key -> Description -> collapsed Advanced.
          <div className="space-y-4">
            {createProviderSection}

            {displayNameField}
            {keyField}
            {descriptionField}
            {activeToggle}

            {/* Advanced params — collapsed by default in create mode. */}
            {createAdvancedDisclosure}

            {saveErrorNode}
          </div>
        ) : (
          // Edit / view modes keep the original field order and locking:
          // Display Name -> Description -> Key -> Active -> Provider -> Model
          // -> always-visible Advanced.
          <div className="space-y-4">
            {displayNameField}
            {descriptionField}
            {keyField}
            {activeToggle}

            <ProfileEditorProviderSection
              provider={provider}
              model={model}
              providerConnection={providerConnection}
              onProviderChange={handleProviderChange}
              onModelChange={handleModelChange}
              onConnectionChange={handleConnectionChange}
              connections={connections}
              isReadOnly={isReadOnly}
              availableConnectionsForProvider={availableConnectionsForProvider}
              connectionNotFound={connectionNotFound}
            />

            {advancedParamsNode}

            {saveErrorNode}
          </div>
        )}
      </Modal.Body>

      <Modal.Footer>
        {effectiveMode === "view" ? (
          <>
            <Button
              variant="outlined"
              onClick={onCancel}
              disabled={saving}
              data-testid="modal-cancel-btn"
            >
              Close
            </Button>
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
            <Button
              variant="outlined"
              onClick={onCancel}
              disabled={saving}
              data-testid="modal-cancel-btn"
            >
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

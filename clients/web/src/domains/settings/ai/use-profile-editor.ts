/**
 * All state, derivation, and persistence logic of the profile editor,
 * shared by its hosts - the modal (composer quick-add) and the settings
 * sidepanel. Hosts render `ProfileEditorFields` with the returned object
 * and their own chrome/footers around `handleSave` / `switchToSaveAsNew`.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { validateInferenceProfileConfig } from "@vellumai/assistant-api";

import { t } from "@/i18n";

import {
  getManagedUpstreamForModel,
  getModelsForProvider,
  parseVellumRoutedModel,
  type LlmCatalogModel,
} from "@/assistant/llm-model-catalog";
import {
  CHATGPT_CONNECTION_PROVIDER,
  OPENAI_COMPATIBLE_PROVIDER,
  VELLUM_CONNECTION_PROVIDER,
} from "@/domains/settings/ai/constants";
import { resolveModelDisplayName } from "@/domains/settings/ai/model-display";
import { connectionServesProvider } from "@/domains/settings/ai/provider-availability";
import { CONNECTION_PROVIDERS } from "@/domains/settings/ai/provider-editor-constants";
import {
  deriveProfileDefaults,
  uniqueProfileName,
} from "@/domains/settings/ai/profile-prefill";
import { toKebabCase } from "@/domains/settings/ai/slugify";
import {
  isGeminiThinkingLevel,
  resolveProfileParamVisibility,
  type GeminiThinkingLevel,
  type ProfileParamVisibility,
} from "@/domains/settings/ai/profile-param-visibility";
import { THINKING_LEVEL_INHERIT } from "@/domains/settings/ai/profile-advanced-params";
import type { ProfileWithName } from "@/domains/settings/ai/utils";
import { useLabelKeySync } from "@/domains/settings/ai/use-label-key-sync";
import {
  configGetOptions,
  inferenceProviderconnectionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  ConnectionProvider,
  ProfileEntry,
  ProfilePatchEntryWritable,
  ProfileStatus,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import { assistantSupportsEntryProviderBinding } from "@/lib/backwards-compat/entry-provider-binding";
import { assistantSupportsVellumProviderProfiles } from "@/lib/backwards-compat/vellum-profile-provider";
import { badRequestMessage } from "@/utils/api-errors";

/**
 * The settings surface persists through the generic config PATCH, which is
 * the deliberately unvalidated escape hatch, so an impossible output budget
 * must be rejected here before the write or it lands stored. The judgment is
 * the daemon's own `validateInferenceProfileConfig` (shared via
 * assistant-api) so the two paths cannot drift; only the copy is local.
 */
function maxTokensBudgetError(
  catalogModel: LlmCatalogModel,
  maxTokens: number,
): string | null {
  const issue = validateInferenceProfileConfig({
    maxTokens,
    modelMaxOutputTokens: catalogModel.maxOutputTokens,
    modelContextWindowTokens: catalogModel.contextWindowTokens,
  });
  if (!issue) {
    return null;
  }
  return issue.code === "over_output_cap"
    ? t("settings:profileEditor.maxTokensOverCap", {
        maxTokens,
        cap: catalogModel.maxOutputTokens,
      })
    : t("settings:profileEditor.maxTokensNoInputRoom", {
        maxTokens,
        window: catalogModel.contextWindowTokens,
      });
}

export type ProfileEditorMode = "create" | "edit" | "view";
export type EffortSelection = "inherit" | NonNullable<ProfileEntry["effort"]>;

export interface UseProfileEditorArgs {
  mode: ProfileEditorMode;
  profileName?: string;
  initialValues?: ProfileWithName;
  existingNames: string[];
  // See ProfileEditorModalProps.connections for nil-vs-empty semantics.
  connections: ProviderConnection[] | undefined;
  assistantId: string;
  /**
   * Persist a profile entry. `options.mode` tells the host how to combine
   * `entry` with the existing on-disk record: `"replace"` (create/edit) via
   * delete-then-recreate so omitted fields reset, `"merge"` (view-mode
   * managed re-enable) via a single deep-merge PATCH.
   */
  onSave: (
    name: string,
    entry: ProfilePatchEntryWritable,
    options?: { mode?: "merge" | "replace" },
  ) => Promise<void>;
}

export interface ProfileEditor {
  effectiveMode: ProfileEditorMode;
  isReadOnly: boolean;
  isInvariant: boolean;
  hasViewModeChanges: boolean;

  label: string;
  description: string;
  key: string;
  provider: ConnectionProvider | "";
  model: string;
  providerConnection: string;
  status: ProfileStatus;

  saving: boolean;
  saveError: string | null;
  /** Why the Name field blocks Save, or null when it does not. */
  nameError: string | null;
  /** Why the Provider field blocks Save, or null when it does not. */
  providerError: string | null;
  isInvalid: boolean;

  maxTokens: number | null;
  contextWindowMaxInputTokens: number | null;
  effort: EffortSelection;
  speed: NonNullable<ProfileEntry["speed"]>;
  verbosity: NonNullable<ProfileEntry["verbosity"]>;
  temperatureEnabled: boolean;
  temperature: number;
  topPEnabled: boolean;
  topP: number;
  thinkingEnabled: boolean;
  thinkingStreamThinking: boolean;
  thinkingLevel: GeminiThinkingLevel | typeof THINKING_LEVEL_INHERIT;

  visibility: ProfileParamVisibility;
  selectedModel: LlmCatalogModel | null;
  defaultMaxOutputTokens: number | undefined;
  defaultContextWindowMaxInputTokens: number | undefined;
  effectiveConnections: ProviderConnection[];
  availableConnectionsForProvider: ProviderConnection[];
  connectionNotFound: boolean;

  creatingProvider: boolean;
  /**
   * The supported-but-unconnected provider the inline create sub-form was
   * opened for, or `null` when it was opened from the generic create entry.
   */
  pendingCreateProvider: ConnectionProvider | null;
  newProviderNote: boolean;

  setDescription: (value: string) => void;
  setStatus: (value: ProfileStatus) => void;
  setMaxTokens: (value: number | null) => void;
  setContextWindowMaxInputTokens: (value: number | null) => void;
  setEffort: (value: EffortSelection) => void;
  setSpeed: (value: NonNullable<ProfileEntry["speed"]>) => void;
  setVerbosity: (value: NonNullable<ProfileEntry["verbosity"]>) => void;
  setTemperatureEnabled: (value: boolean) => void;
  setTemperature: (value: number) => void;
  setTopPEnabled: (value: boolean) => void;
  setTopP: (value: number) => void;
  setThinkingEnabled: (value: boolean) => void;
  setThinkingStreamThinking: (value: boolean) => void;
  setThinkingLevel: (
    value: GeminiThinkingLevel | typeof THINKING_LEVEL_INHERIT,
  ) => void;
  setCreatingProvider: (value: boolean) => void;
  setPendingCreateProvider: (value: ConnectionProvider | null) => void;
  setNewProviderNote: (value: boolean) => void;

  handleLabelChange: (value: string) => void;
  /** Resolve a duplicate Name into "Name (2)" once the user leaves the field. */
  handleLabelBlur: () => void;
  handleProviderChange: (provider: ConnectionProvider) => void;
  handleConnectionChange: (connection: string) => void;
  handleModelChange: (model: string) => void;
  handleProviderCreated: (connection: ProviderConnection) => void;
  setProviderConnection: (value: string) => void;
  setModel: (value: string) => void;

  handleSave: () => Promise<void>;
  /** "Save As New": duplicate a read-only profile into a fresh create. */
  switchToSaveAsNew: () => void;
}

export function useProfileEditor({
  mode,
  profileName,
  initialValues,
  existingNames,
  connections,
  assistantId,
  onSave,
}: UseProfileEditorArgs): ProfileEditor {
  const [effectiveMode, setEffectiveMode] = useState<ProfileEditorMode>(mode);
  // Managed profiles are read-only: no rename, no reshaping, no disabling -
  // the only interactive control is the enable-only status flip when the
  // profile is disabled. The lock keys off the server-stamped `invariant`
  // wire flag, so it must hold even if the host opens the editor in edit
  // mode. Customization goes through "Save As New", which switches
  // `effectiveMode` to "create" and therefore drops the lock on the duplicate.
  const isInvariant =
    initialValues?.invariant === true && effectiveMode !== "create";
  // The invariant lock forces read-only handling even in edit mode, so Save
  // takes the partial-merge path and never the delete/recreate cycle the
  // daemon rejects for managed profiles.
  const isReadOnly = effectiveMode === "view" || isInvariant;

  // Baseline for `hasViewModeChanges`: the enable flip is the only edit
  // read-only mode permits.
  const initialStatus: ProfileStatus = initialValues?.status ?? "active";

  const [label, setLabel] = useState(initialValues?.label ?? "");
  const [description, setDescription] = useState(
    initialValues?.description ?? "",
  );
  const [key, setKey] = useState(mode === "create" ? "" : (profileName ?? ""));
  // "vellum" is a picker-level value: profiles bound to the Vellum-managed
  // connection present (and edit) as provider "Vellum"; the wire-shape
  // upstream is derived from the model at save time. The form opens on the
  // stored upstream and only promotes to Vellum once the loaded connections
  // prove the bound row is the managed sentinel (see the effect below).
  // A stored "chatgpt" provider (migration 144 output, the picker, or the
  // API) opens as the ChatGPT selection.
  const [provider, setProvider] = useState<ConnectionProvider | "">(
    initialValues?.provider
      ? // The wire type is an open string (the daemon accepts entry names in
        // storage); the editor's selection set is the connection-provider
        // union, and a value outside it renders as no selection.
        (initialValues.provider as ConnectionProvider)
      : "",
  );
  const [model, setModel] = useState(initialValues?.model ?? "");
  // Per-profile provider-connection binding. Empty string means no explicit
  // binding - daemon falls back to its first-connection dispatch. Snake_case
  // `provider_connection` matches the wire schema.
  const [providerConnection, setProviderConnection] = useState(
    initialValues?.provider_connection ?? "",
  );
  const [status, setStatus] = useState<ProfileStatus>(
    initialValues?.status ?? "active",
  );
  // Connections created inline this session, before the host's `connections`
  // prop has refetched. Unioned into the available-connections set so a
  // just-created binding is treated as valid immediately.
  const [locallyCreatedConnections, setLocallyCreatedConnections] = useState<
    ProviderConnection[]
  >([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Advanced params - sliders (null = "inherit / not overridden")
  const [maxTokens, setMaxTokens] = useState<number | null>(
    initialValues?.maxTokens ?? null,
  );
  const [contextWindowMaxInputTokens, setContextWindowMaxInputTokens] =
    useState<number | null>(
      initialValues?.contextWindow?.maxInputTokens ?? null,
    );

  // Advanced params - segment controls
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

  // Advanced params - temperature / top P
  const [temperatureEnabled, setTemperatureEnabled] = useState<boolean>(
    typeof initialValues?.temperature === "number",
  );
  const [temperature, setTemperature] = useState<number>(
    typeof initialValues?.temperature === "number"
      ? initialValues.temperature
      : 0.7,
  );
  const [topPEnabled, setTopPEnabled] = useState<boolean>(
    typeof initialValues?.topP === "number",
  );
  const [topP, setTopP] = useState<number>(
    typeof initialValues?.topP === "number" ? initialValues.topP : 0.95,
  );

  // True when read-only mode's one permitted edit - the enable flip
  // (disabled → active) - has been made.
  const hasViewModeChanges = isReadOnly && status !== initialStatus;

  // Advanced params - thinking
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

  // Derived: selected model from catalog. A saved Vellum model may be a
  // routed `<provider>/<model>` string; parse it once - the native id feeds
  // every catalog lookup and the save path, the prefix feeds upstream
  // derivation.
  const routedModel = useMemo(
    () =>
      provider === VELLUM_CONNECTION_PROVIDER
        ? parseVellumRoutedModel(model)
        : null,
    [provider, model],
  );
  const nativeModel = routedModel?.model ?? model;

  const selectedModel = useMemo(
    () =>
      provider
        ? (getModelsForProvider(provider).find((m) => m.id === nativeModel) ??
          null)
        : null,
    [provider, nativeModel],
  );

  // The advanced-param defaults a profile inherits when it omits an override
  // live on `llm.default`, not on the profile fragment the editor edits.
  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  const defaultMaxOutputTokens = config?.llm?.default?.maxTokens;
  const defaultContextWindowMaxInputTokens =
    config?.llm?.default?.contextWindow?.maxInputTokens;

  // Derived: which advanced param fields to show
  const visibility = useMemo(
    () =>
      resolveProfileParamVisibility(
        provider === VELLUM_CONNECTION_PROVIDER
          ? (routedModel?.provider ??
              getManagedUpstreamForModel(model) ??
              initialValues?.provider ??
              "")
          : provider,
        nativeModel,
      ),
    [provider, model, nativeModel, routedModel, initialValues?.provider],
  );

  // Host-supplied connections unioned with any created inline this session
  // (deduped by name, prop wins).
  const effectiveConnections = useMemo(() => {
    const base = connections ?? [];
    if (locallyCreatedConnections.length === 0) {
      return base;
    }
    const known = new Set(base.map((c) => c.name));
    return [
      ...base,
      ...locallyCreatedConnections.filter((c) => !known.has(c.name)),
    ];
  }, [connections, locallyCreatedConnections]);

  const availableConnectionsForProvider = useMemo(
    () =>
      provider
        ? effectiveConnections.filter(
            (c) =>
              connectionServesProvider(c.provider, provider) ||
              // Legacy pinned pairing dispatch still accepts: an openai
              // profile bound by name to the canonical subscription row,
              // whose stored provider is "chatgpt" once DB migration 366
              // has run. Migration 144 leaves these pins in place; without
              // this the editor reads the binding as missing and clears it
              // on save.
              (provider === "openai" &&
                c.name === providerConnection &&
                c.provider === CHATGPT_CONNECTION_PROVIDER),
          )
        : [],
    [provider, effectiveConnections, providerConnection],
  );

  // Saved binding no longer points at any known connection. The save handler
  // auto-clears it; the provider section surfaces a warning to the user.
  const connectionNotFound =
    providerConnection !== "" &&
    !availableConnectionsForProvider.some((c) => c.name === providerConnection);

  const { handleLabelChange, resetDirty, getDirty } = useLabelKeySync(
    effectiveMode,
    setLabel,
    setKey,
  );

  // The last Name this editor filled in from a model pick. A Name that still
  // matches it is the editor's own, so the next model pick may replace it; a
  // Name the user typed never is.
  const autoFilledLabelRef = useRef<string | null>(null);

  const queryClient = useQueryClient();

  // Create-mode-only UI: whether the inline "+ Create new provider" sub-form
  // is mounted.
  const [creatingProvider, setCreatingProvider] = useState(false);
  // The supported-but-unconnected provider the inline sub-form was opened for,
  // or null when it was opened from the generic create entry. It preselects the
  // sub-form's own Provider picker and keeps the outer trigger showing the
  // provider the user actually picked while the form is open. The profile's
  // `provider` is deliberately NOT set until the connection exists - cancelling
  // must not strand the profile on a route the daemon can't dispatch through.
  const [pendingCreateProvider, setPendingCreateProvider] =
    useState<ConnectionProvider | null>(null);
  // One-time helper note shown after an inline provider create succeeds.
  const [newProviderNote, setNewProviderNote] = useState(false);

  // Promote a vellum-bound profile into Vellum picker mode once the loaded
  // connections prove the bound row is the managed sentinel. Skipped once the
  // user changes the provider themselves.
  useEffect(() => {
    if (initialValues?.provider_connection !== VELLUM_CONNECTION_PROVIDER) {
      return;
    }
    if (provider !== (initialValues?.provider ?? "")) {
      return;
    }
    const boundRow = connections?.find(
      (c) => c.name === initialValues.provider_connection,
    );
    if (boundRow?.provider === VELLUM_CONNECTION_PROVIDER) {
      setProvider(VELLUM_CONNECTION_PROVIDER);
    }
  }, [connections, provider, initialValues]);

  // Open a stored entry-name provider (the entries model: the binding lives
  // IN the provider value) as its row's kind plus the row as the binding,
  // so the picker and model logic stay vendor-keyed. Skipped once the user
  // changes the provider; identity rows keep their own flows above.
  useEffect(() => {
    const stored = initialValues?.provider;
    if (!stored || provider !== stored) {
      return;
    }
    // A provider id is never an entry name: the daemon reads a bare id as
    // "the kind's default entry", so a row that happens to carry such a
    // name must not pin or re-vendor the profile on open.
    if (
      CONNECTION_PROVIDERS.includes(stored as ConnectionProvider) ||
      stored === VELLUM_CONNECTION_PROVIDER ||
      stored === CHATGPT_CONNECTION_PROVIDER
    ) {
      return;
    }
    const row = connections?.find((c) => c.name === stored);
    if (
      !row ||
      row.provider === VELLUM_CONNECTION_PROVIDER ||
      row.provider === CHATGPT_CONNECTION_PROVIDER
    ) {
      return;
    }
    setProvider(row.provider);
    if (providerConnection === "") {
      setProviderConnection(row.name);
    }
  }, [connections, provider, providerConnection, initialValues]);

  // Reset dirty tracking when the editor re-opens with new values.
  useEffect(() => {
    resetDirty();
    autoFilledLabelRef.current = null;
    setCreatingProvider(false);
    setPendingCreateProvider(null);
    setNewProviderNote(false);
    setLocallyCreatedConnections([]);
  }, [profileName, mode, resetDirty]);

  function handleProviderChange(newProvider: ConnectionProvider) {
    if (newProvider === provider) {
      return;
    }
    setProvider(newProvider);
    setModel("");
    // Auto-select connection: if exactly one connection exists for the new
    // provider, select it automatically. If multiple exist, clear so the user
    // must pick. If zero, clear. The chatgpt identity never binds a
    // connection: dispatch resolves the canonical subscription row
    // per-request, and the daemon rejects noncanonical pins.
    const connectionsForProvider =
      newProvider === CHATGPT_CONNECTION_PROVIDER
        ? []
        : effectiveConnections.filter((c) =>
            connectionServesProvider(c.provider, newProvider),
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
        // "Any connection" - merge models from all connections and keep the
        // model if it exists in the merged set.
        const allModelIds = new Set(
          availableConnectionsForProvider.flatMap((c) =>
            (c.models ?? []).map((m) => m.id),
          ),
        );
        if (!allModelIds.has(model)) {
          setModel("");
        }
      } else {
        const conn = availableConnectionsForProvider.find(
          (c) => c.name === newConnection,
        );
        const connModelIds = new Set((conn?.models ?? []).map((m) => m.id));
        if (!connModelIds.has(model)) {
          setModel("");
        }
      }
    }
  }

  function handleModelChange(newModel: string) {
    if (newModel === model) {
      return;
    }
    setModel(newModel);
    // Reset token sliders when model changes
    setMaxTokens(null);
    setContextWindowMaxInputTokens(null);
    // Create-mode pre-fill: seed Name (and the Key it derives) from the
    // model's display name. A Name the user typed is never overwritten; an
    // empty one, or one this editor filled in for an earlier model pick, is.
    const labelIsOurs =
      label.trim() === "" || label === autoFilledLabelRef.current;
    if (effectiveMode === "create" && newModel && labelIsOurs) {
      const { name, key: derivedKey } = deriveProfileDefaults(
        resolveModelDisplayName(
          provider || undefined,
          newModel,
          availableConnectionsForProvider,
        ),
        existingNames,
      );
      autoFilledLabelRef.current = name;
      setLabel(name);
      setKey(derivedKey);
    }
  }

  // Two profiles cannot share a key, and the key is the slug of the Name, so a
  // Name that collides is a Name that cannot be saved. With no Key field left
  // to edit, blocking Save on a duplicate would be a dead end, so the
  // collision is resolved where the user can watch it happen: leaving the
  // field appends the lowest free "(N)".
  //
  // Create mode only. An existing profile keeps the key it was stored under,
  // so renaming it cannot collide with anything.
  function handleLabelBlur() {
    const trimmed = label.trim();
    if (effectiveMode !== "create" || isReadOnly || trimmed === "") {
      return;
    }
    const unique = uniqueProfileName(trimmed, existingNames);
    if (unique === label) {
      return;
    }
    // The user typed this one, so a later model pick must not overwrite it.
    autoFilledLabelRef.current = null;
    setLabel(unique);
    setKey(toKebabCase(unique));
  }

  // Inline provider create: bind the new connection as this profile's
  // provider + connection, collapse the sub-form, surface the helper note,
  // and invalidate the connections query so pickers pick up the row.
  function handleProviderCreated(connection: ProviderConnection) {
    // The create form can't produce a vellum connection; bail before touching
    // any state so the sub-form can't get stuck.
    const newProvider = connection.provider;
    if (newProvider === "vellum") {
      return;
    }
    setLocallyCreatedConnections((prev) =>
      prev.some((c) => c.name === connection.name)
        ? prev
        : [...prev, connection],
    );
    setProvider(newProvider);
    setProviderConnection(connection.name);
    setModel("");
    setCreatingProvider(false);
    setPendingCreateProvider(null);
    setNewProviderNote(true);
    void queryClient.invalidateQueries({
      queryKey: inferenceProviderconnectionsGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
  }

  // Validation. The key is not a field any more: it is the slug of the Name,
  // so both failures it can have (nothing to slugify, a slug already taken)
  // are reported against the Name the user can actually act on.
  const keyTrimmed = key.trim();
  const keyEmpty = keyTrimmed.length === 0;
  const keyNotUnique =
    effectiveMode === "create"
      ? existingNames.includes(keyTrimmed)
      : existingNames.filter((n) => n !== profileName).includes(keyTrimmed);
  const providerMissing = provider.length === 0;
  const providerWithoutModel = provider.length > 0 && model.length === 0;

  const isInvalid =
    keyEmpty || keyNotUnique || providerMissing || providerWithoutModel;

  // An untouched create form is blank by definition, so flagging its empty
  // fields on open would be scolding the user for not having started. Edit
  // mode is the opposite: an existing profile missing a provider or model is
  // already broken, the resolver already skips it, and the row that links
  // here says "Click to fix", so the reason has to be visible on arrival.
  // The Model field already explains `providerWithoutModel` itself, keyed to
  // why it is empty (no catalog entries, connection not configured, nothing
  // picked). Provider and Name are the blocking states with no copy anywhere.
  // Read-only (managed) profiles get no field errors: every control is
  // disabled, so naming a problem the user cannot act on here is just noise.
  // A "Save As New" duplicate (`effectiveMode` has moved off the mode the
  // host opened) is not a blank form either: every field arrives seeded, so a
  // seeded value that cannot be saved has to say so rather than leave Save
  // disarmed for a reason nothing on screen gives.
  const showFieldErrors =
    !isReadOnly &&
    (effectiveMode === "edit" || effectiveMode !== mode || getDirty());
  const providerError =
    showFieldErrors && providerMissing
      ? t("settings:profileEditor.providerRequired")
      : null;
  const nameError = !showFieldErrors
    ? null
    : keyEmpty
      ? t("settings:profileEditor.nameRequired")
      : keyNotUnique
        ? t("settings:profileEditor.nameTaken")
        : null;

  async function handleSave() {
    if (isInvalid && !isReadOnly) {
      return;
    }
    // Read-only (managed) profiles reach Save only via the enable flip - the
    // daemon rejects every other mutation on them - so the body is exactly
    // `{status: "active"}` sent as a deep-merge so the seed-owned fields
    // (provider, model, advanced params) stay intact.
    if (isReadOnly) {
      if (!hasViewModeChanges) {
        return;
      }
      setSaving(true);
      setSaveError(null);
      try {
        await onSave(keyTrimmed, { status: "active" }, { mode: "merge" });
      } catch (error) {
        // A 400 names why the profile can't be enabled (no connection or key
        // for its provider); anything else is opaque, so keep the retry copy.
        setSaveError(
          badRequestMessage(error) ??
            "Failed to save profile. Please try again.",
        );
      } finally {
        setSaving(false);
      }
      return;
    }
    // `selectedModel` already resolves the routed `<provider>/<model>` form
    // to its native catalog entry, so the judgment sees the same model the
    // save will dispatch.
    if (visibility.maxTokens && maxTokens !== null && selectedModel) {
      const budgetError = maxTokensBudgetError(selectedModel, maxTokens);
      if (budgetError) {
        setSaveError(budgetError);
        return;
      }
    }
    setSaving(true);
    setSaveError(null);
    try {
      const entry: ProfilePatchEntryWritable = {};
      // Stale bindings are auto-cleared on save; when providerConnection is
      // empty and there's exactly one available connection, resolve to that
      // connection's name so profiles always persist with an explicit binding.
      const resolvedBinding =
        providerConnection === "" &&
        availableConnectionsForProvider.length === 1
          ? availableConnectionsForProvider[0].name
          : providerConnection;
      const effectiveBinding = connectionNotFound ? "" : resolvedBinding;
      // The Vellum picker entry's wire shape is version-gated. Daemons at the
      // gate's MIN_VERSION store the routing identity directly
      // (`provider: "vellum"` + native model, no binding); older daemons get
      // the legacy shape: the model's managed upstream as `provider`, bound
      // to the provider-agnostic vellum connection.
      // The chatgpt identity needs no version gate: the picker offers it
      // only when the daemon returned a provider "chatgpt" row, which only
      // daemons that understand the identity payload do.
      const writesIdentityPayload =
        provider === CHATGPT_CONNECTION_PROVIDER ||
        (provider === VELLUM_CONNECTION_PROVIDER &&
          (await assistantSupportsVellumProviderProfiles(assistantId)));
      const wireProvider =
        provider === VELLUM_CONNECTION_PROVIDER
          ? writesIdentityPayload
            ? VELLUM_CONNECTION_PROVIDER
            : (routedModel?.provider ??
              getManagedUpstreamForModel(model) ??
              initialValues?.provider ??
              "")
          : provider;
      const wireModel = nativeModel;
      // Identity payloads carry no binding; sending null on edit clears a
      // legacy-shape binding left on the stored profile.
      let wireBinding = writesIdentityPayload ? "" : effectiveBinding;
      // Entries wire shape (version-gated): gated daemons store the binding
      // IN the provider value (the entry name when the user picked a named
      // row among siblings and always for openai-compatible endpoints, the
      // bare vendor id meaning the kind's default entry otherwise) and
      // never a provider_connection. Identity-bound rows keep their
      // existing payloads: rewriting a vellum/chatgpt binding as an entry
      // name would change what the daemon bills the request to.
      const boundRow =
        effectiveBinding !== ""
          ? effectiveConnections.find((c) => c.name === effectiveBinding)
          : undefined;
      // A binding is only expressible as an entry name when the daemon
      // would read that name back as this row. Identity rows dispatch by
      // their own rules, and a row named after a provider id or identity
      // value reads as "the kind's default entry" or the identity, not as
      // the row: all of those keep the legacy shape so the pin survives.
      const bindingInexpressibleAsEntryName =
        boundRow !== undefined &&
        (boundRow.provider === VELLUM_CONNECTION_PROVIDER ||
          boundRow.provider === CHATGPT_CONNECTION_PROVIDER ||
          boundRow.name === VELLUM_CONNECTION_PROVIDER ||
          boundRow.name === CHATGPT_CONNECTION_PROVIDER ||
          CONNECTION_PROVIDERS.includes(boundRow.name as ConnectionProvider));
      let entryWireProvider = wireProvider;
      if (
        !writesIdentityPayload &&
        provider !== "" &&
        provider !== VELLUM_CONNECTION_PROVIDER &&
        !bindingInexpressibleAsEntryName &&
        (await assistantSupportsEntryProviderBinding(assistantId))
      ) {
        const kindSiblings = effectiveConnections.filter(
          (c) => c.provider === provider,
        ).length;
        entryWireProvider =
          boundRow !== undefined &&
          (provider === OPENAI_COMPATIBLE_PROVIDER || kindSiblings >= 2)
            ? boundRow.name
            : provider;
        wireBinding = "";
      }
      if (effectiveMode === "edit") {
        // In edit mode send null for cleared fields so the server deep-merges
        // them as cleared rather than silently preserving the old value.
        entry.label = label.trim() || null;
        entry.description = description.trim() || null;
        entry.provider = entryWireProvider || null;
        entry.model = wireModel || null;
        entry.provider_connection = wireBinding || null;
      } else {
        // In create mode omit optional fields that are still empty.
        if (label.trim()) {
          entry.label = label.trim();
        }
        if (description.trim()) {
          entry.description = description.trim();
        }
        if (entryWireProvider) {
          entry.provider = entryWireProvider;
        }
        if (wireModel) {
          entry.model = wireModel;
        }
        if (wireBinding) {
          entry.provider_connection = wireBinding;
        }
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
      // Status - always include in edit mode; omit in create when active
      if (effectiveMode === "edit") {
        entry.status = status;
      } else if (status !== "active") {
        entry.status = status;
      }
      // Do NOT include source or name
      await onSave(keyTrimmed, entry);
    } catch (error) {
      setSaveError(
        badRequestMessage(error) ?? "Failed to save profile. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  function switchToSaveAsNew() {
    setEffectiveMode("create");
    resetDirty();
    // The duplicate keeps the source profile's Name, which is by definition
    // already taken, so it opens on the lowest free "(N)" and on the key that
    // Name slugifies to. Leaving the key empty instead would disarm Save with
    // no error to explain it: the Key field is gone, and a Name nobody has
    // touched reports nothing.
    const base = label.trim() || (profileName ?? "").trim();
    const { name, key: derivedKey } = deriveProfileDefaults(
      base,
      existingNames,
    );
    // The editor derived this Name, not the user, so a later model pick may
    // still replace it.
    autoFilledLabelRef.current = name;
    setLabel(name);
    setKey(derivedKey);
  }

  return {
    effectiveMode,
    isReadOnly,
    isInvariant,
    hasViewModeChanges,
    label,
    description,
    key,
    provider,
    model,
    providerConnection,
    status,
    saving,
    saveError,
    nameError,
    providerError,
    isInvalid,
    maxTokens,
    contextWindowMaxInputTokens,
    effort,
    speed,
    verbosity,
    temperatureEnabled,
    temperature,
    topPEnabled,
    topP,
    thinkingEnabled,
    thinkingStreamThinking,
    thinkingLevel,
    visibility,
    selectedModel,
    defaultMaxOutputTokens,
    defaultContextWindowMaxInputTokens,
    effectiveConnections,
    availableConnectionsForProvider,
    connectionNotFound,
    creatingProvider,
    pendingCreateProvider,
    newProviderNote,
    setDescription,
    setStatus,
    setMaxTokens,
    setContextWindowMaxInputTokens,
    setEffort,
    setSpeed,
    setVerbosity,
    setTemperatureEnabled,
    setTemperature,
    setTopPEnabled,
    setTopP,
    setThinkingEnabled,
    setThinkingStreamThinking,
    setThinkingLevel,
    setCreatingProvider,
    setPendingCreateProvider,
    setNewProviderNote,
    handleLabelChange,
    handleLabelBlur,
    handleProviderChange,
    handleConnectionChange,
    handleModelChange,
    handleProviderCreated,
    setProviderConnection,
    setModel,
    handleSave,
    switchToSaveAsNew,
  };
}

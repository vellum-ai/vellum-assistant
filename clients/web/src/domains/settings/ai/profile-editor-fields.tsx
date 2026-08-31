import { ChevronRight } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Select } from "@vellumai/design-library/components/select";
import { Input, Textarea } from "@vellumai/design-library/components/input";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { Typography } from "@vellumai/design-library/components/typography";

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import { OPENAI_COMPATIBLE_PROVIDER } from "@/domains/settings/ai/constants";
import { ProfileAdvancedParams } from "@/domains/settings/ai/profile-advanced-params";
import { ProfileEditorProviderSection } from "@/domains/settings/ai/profile-editor-provider-section";
import {
  entryPickerValue,
  expandEndpointEntries,
  parseEntryPickerValue,
  providersServedByConnections,
  unconnectedProviders,
} from "@/domains/settings/ai/provider-availability";
import {
  PickerMeta,
  useProviderPickerAvailability,
} from "@/domains/settings/ai/provider-picker-availability";
import { ProviderCreateForm } from "@/domains/settings/ai/provider-create-form";
import { connectionAuthTypeForProvider } from "@/domains/settings/ai/provider-editor-constants";
import type { ProfileEditor } from "@/domains/settings/ai/use-profile-editor";
import type {
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import { useTranslation, Trans } from "@/i18n";

// Sentinel value for the "+ Create new provider" option in the create-mode
// Provider dropdown. Picking it mounts the inline ProviderCreateForm instead
// of selecting a provider.
const CREATE_NEW_PROVIDER_SENTINEL = "__create_new_provider__";

export interface ProfileEditorFieldsProps {
  editor: ProfileEditor;
  assistantId: string;
  /** Raw host-supplied connections (see ProfileEditorModalProps.connections). */
  connections: ProviderConnection[] | undefined;
  /**
   * Host chrome the fields render into:
   * - `"modal"`: the modal layouts - create keeps Description, Name and the
   *   advanced params behind a collapsed Advanced disclosure.
   * - `"panel"`: the settings sidepanel (Figma 7412:134288) - every field
   *   is flat and always visible.
   */
  variant: "modal" | "panel";
}

/**
 * The profile editor's field stack, shared by the modal host (composer
 * quick-add) and the settings sidepanel. All state lives in the
 * `useProfileEditor` hook; this component only arranges fields per
 * mode/variant.
 *
 * Creating a profile asks two questions: which provider, and which model.
 * Everything the model can answer for itself - the Name, and the parameters
 * that model supports - sits under Advanced for the minority who want to
 * change it. The Key is not asked at all: it is always the slug of the Name.
 * Enabling and disabling is not asked either; a new profile is active, and the
 * row's kebab menu turns one off later.
 */
export function ProfileEditorFields({
  editor,
  assistantId,
  connections,
  variant,
}: ProfileEditorFieldsProps) {
  const { t } = useTranslation("settings");
  const providerAvailability = useProviderPickerAvailability();
  const isCreate = editor.effectiveMode === "create";
  const flat = variant === "panel";

  // Create-mode Advanced disclosure (modal variant only). Local state is
  // fine: hosts remount the fields on each open, matching the old reset.
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  // The Name lives under Advanced, so a Name the user has to fix cannot be
  // left hidden behind a collapsed disclosure.
  const createAdvancedOpen = advancedExpanded || Boolean(editor.nameError);

  const displayNameField = (
    <div className="space-y-1">
      <label className="block text-body-small-default text-[var(--content-tertiary)]">
        {isCreate
          ? t("profileEditorFields.nameLabel")
          : t("profileEditorFields.displayNameLabel")}
      </label>
      <Input
        type="text"
        value={editor.label}
        onChange={(e) => editor.handleLabelChange(e.target.value)}
        onBlur={editor.handleLabelBlur}
        placeholder={t("profileEditorFields.displayNamePlaceholder")}
        disabled={editor.isReadOnly}
        errorText={editor.isReadOnly ? undefined : editor.nameError}
        fullWidth
      />
    </div>
  );

  const descriptionField = (
    <Textarea
      label={
        <Trans
          i18nKey="profileEditorFields.descriptionLabel"
          ns="settings"
          components={{
            optional: (
              <span className="text-[var(--content-disabled)]" />
            ),
          }}
        />
      }
      value={editor.description}
      onChange={(e) => editor.setDescription(e.target.value)}
      placeholder={t("profileEditorFields.descriptionPlaceholder")}
      disabled={editor.isReadOnly}
      rows={2}
      fullWidth
      className="resize-none"
    />
  );

  // Enabling and disabling a profile the user owns lives on its row's kebab
  // menu, so the editor does not ask: a new profile is active, and an existing
  // one keeps whatever the row set. The one case the row cannot serve is a
  // managed profile opened read-only and already disabled, where this
  // enable-only toggle is the whole reason the form can be saved at all. The
  // panel variant never shows it - it reaches managed profiles through
  // "Save As New".
  const activeToggle =
    !flat && editor.isReadOnly && editor.status === "disabled" ? (
      <Toggle
        // Enable-only: the flip is what arms Save, and it unmounts the toggle
        // with it, because a managed profile cannot be disabled from here.
        checked={false}
        onChange={() => editor.setStatus("active")}
        label={t("profileEditorFields.activeLabel")}
        className="touch-mobile:mt-2 touch-mobile:[&_button]:h-7 touch-mobile:[&_button]:w-10 touch-mobile:[&_button>span]:h-6 touch-mobile:[&_button>span]:w-6"
      />
    ) : null;

  const advancedParamsNode = (
    <ProfileAdvancedParams
      visibility={editor.visibility}
      isReadOnly={editor.isReadOnly}
      model={editor.model}
      selectedModel={editor.selectedModel}
      defaultMaxOutputTokens={editor.defaultMaxOutputTokens}
      defaultContextWindowMaxInputTokens={
        editor.defaultContextWindowMaxInputTokens
      }
      maxTokens={editor.maxTokens}
      onMaxTokensChange={editor.setMaxTokens}
      contextWindowMaxInputTokens={editor.contextWindowMaxInputTokens}
      onContextWindowChange={editor.setContextWindowMaxInputTokens}
      effort={editor.effort}
      onEffortChange={editor.setEffort}
      speed={editor.speed}
      onSpeedChange={editor.setSpeed}
      verbosity={editor.verbosity}
      onVerbosityChange={editor.setVerbosity}
      temperatureEnabled={editor.temperatureEnabled}
      onTemperatureEnabledChange={editor.setTemperatureEnabled}
      temperature={editor.temperature}
      onTemperatureChange={editor.setTemperature}
      topPEnabled={editor.topPEnabled}
      onTopPEnabledChange={editor.setTopPEnabled}
      topP={editor.topP}
      onTopPChange={editor.setTopP}
      thinkingEnabled={editor.thinkingEnabled}
      onThinkingEnabledChange={editor.setThinkingEnabled}
      thinkingStreamThinking={editor.thinkingStreamThinking}
      onThinkingStreamThinkingChange={editor.setThinkingStreamThinking}
      thinkingLevel={editor.thinkingLevel}
      onThinkingLevelChange={editor.setThinkingLevel}
    />
  );

  const saveErrorNode = editor.saveError ? (
    <Typography
      variant="body-small-default"
      as="p"
      className="text-(--system-negative-strong)"
    >
      {editor.saveError}
    </Typography>
  ) : null;

  // ---- Create-mode: provider-first picker with inline create ----

  // Providers with no connection yet. Listed after the connected entries so a
  // ready-to-use provider is never buried, and routed into the inline create
  // form on selection.
  const providersNeedingSetup = useMemo(
    () => unconnectedProviders(editor.effectiveConnections),
    [editor.effectiveConnections],
  );

  // Every provider the catalog knows, connected ones first, then the rest
  // annotated with what they still need, then the always-present "+ Create new
  // provider" sentinel for custom endpoints. A provider this assistant cannot
  // reach keeps its row, disabled and annotated with why.
  const createModeProviderOptions = useMemo(() => {
    const opts: {
      value: string;
      label: string;
      suffix?: ReactNode;
      sticky?: boolean;
      disabled?: boolean;
      tooltip?: ReactNode;
    }[] = expandEndpointEntries(
      providersServedByConnections(editor.effectiveConnections),
      editor.effectiveConnections,
      (p) => PROVIDER_DISPLAY_NAMES[p] ?? p,
      t("aiProviderPicker.defaultEntryMeta"),
    ).map(({ value, label, meta }) => ({
      value,
      label,
      suffix: meta ? <PickerMeta text={meta} /> : undefined,
      ...providerAvailability(value),
    }));
    for (const unconnected of providersNeedingSetup) {
      const meta =
        connectionAuthTypeForProvider(unconnected) === "api_key"
          ? t("profileEditorFields.addApiKey")
          : t("profileEditorFields.setUp");
      opts.push({
        value: unconnected,
        label: PROVIDER_DISPLAY_NAMES[unconnected] ?? unconnected,
        suffix: <PickerMeta text={meta} />,
        ...providerAvailability(unconnected),
      });
    }
    opts.push({
      value: CREATE_NEW_PROVIDER_SENTINEL,
      label: t("profileEditorFields.createNewProvider"),
      // The catalog grows past the menu's height, so the escape hatch is
      // pinned rather than left at the end of a scroll.
      sticky: true,
    });
    return opts;
  }, [
    editor.effectiveConnections,
    providerAvailability,
    providersNeedingSetup,
    t,
  ]);

  const createProviderSection = (
    <div className="space-y-4">
      <div className="space-y-1">
        <label
          id="profile-editor-provider-label"
          className="block text-body-small-default text-[var(--content-tertiary)]"
        >
          {t("profileEditorFields.providerLabel")}
        </label>
        <Select
          value={
            editor.creatingProvider
              ? (editor.pendingCreateProvider ?? CREATE_NEW_PROVIDER_SENTINEL)
              : editor.provider &&
                  editor.providerConnection &&
                  createModeProviderOptions.some(
                    (option) =>
                      option.value ===
                      entryPickerValue(
                        editor.provider,
                        editor.providerConnection,
                      ),
                  )
                ? entryPickerValue(editor.provider, editor.providerConnection)
                : editor.provider
          }
          onChange={(next) => {
            if (next === CREATE_NEW_PROVIDER_SENTINEL) {
              editor.setCreatingProvider(true);
              editor.setPendingCreateProvider(null);
              editor.setNewProviderNote(false);
              return;
            }
            if (!next) {
              return;
            }
            const entry = parseEntryPickerValue(next);
            if (entry) {
              // An entry row implies its kind plus the binding. Endpoint
              // model lists differ per entry, so switching endpoints
              // re-picks the model; same-kind catalog entries share one
              // list, so the model survives.
              editor.setCreatingProvider(false);
              editor.setPendingCreateProvider(null);
              if (editor.provider !== entry.provider) {
                editor.handleProviderChange(entry.provider);
              } else if (entry.provider === OPENAI_COMPATIBLE_PROVIDER) {
                editor.setModel("");
              }
              editor.setProviderConnection(entry.connectionName);
              return;
            }
            const picked = next as ConnectionProvider;
            if (providersNeedingSetup.includes(picked)) {
              // Nothing to dispatch through yet — hand the user straight to
              // the create form for that provider instead of a dead selection.
              editor.setCreatingProvider(true);
              editor.setPendingCreateProvider(picked);
              editor.setNewProviderNote(false);
              return;
            }
            editor.setCreatingProvider(false);
            editor.setPendingCreateProvider(null);
            editor.handleProviderChange(picked);
            // Re-picking the current kind's bare row means "the default
            // entry": the explicit binding must clear, and the provider
            // change above no-ops so it won't do it.
            if (picked === editor.provider) {
              editor.setProviderConnection("");
            }
          }}
          placeholder={t("profileEditorFields.selectProviderPlaceholder")}
          aria-labelledby="profile-editor-provider-label"
          options={createModeProviderOptions}
        />
        {editor.newProviderNote ? (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-tertiary)]"
          >
            {t("profileEditorFields.newProviderNote")}
          </Typography>
        ) : null}
      </div>

      {editor.creatingProvider ? (
        // Keyed by the preselected provider: the sub-form seeds its provider,
        // label, and credential ref from props at mount, so switching the
        // outer picker to another unconnected provider must remount it.
        <ProviderCreateForm
          key={editor.pendingCreateProvider ?? "any"}
          variant="inline"
          assistantId={assistantId}
          existingNames={editor.effectiveConnections.map((c) => c.name)}
          connections={editor.effectiveConnections}
          defaultProviderType={
            (editor.pendingCreateProvider ?? editor.provider) || undefined
          }
          hideProviderSelect={editor.pendingCreateProvider !== null}
          onCreated={editor.handleProviderCreated}
          onCancel={() => {
            editor.setCreatingProvider(false);
            editor.setPendingCreateProvider(null);
          }}
        />
      ) : (
        <ProfileEditorProviderSection
          provider={editor.provider}
          model={editor.model}
          providerConnection={editor.providerConnection}
          onProviderChange={editor.handleProviderChange}
          onModelChange={editor.handleModelChange}
          onConnectionChange={editor.handleConnectionChange}
          connections={editor.effectiveConnections}
          isReadOnly={editor.isReadOnly}
          availableConnectionsForProvider={
            editor.availableConnectionsForProvider
          }
          connectionNotFound={editor.connectionNotFound}
          hideProviderField
        />
      )}
    </div>
  );

  if (isCreate) {
    // Advanced only surfaces once a model is chosen: the Name derives from
    // the model, and the model controls the available advanced parameters.
    const modelChosen = editor.model !== "";
    // Description first, then Name, then the model's parameters. Name sits
    // below Description because the model has already filled it in: it is the
    // field most people scroll past, not the one they came here to set.
    const advancedFields = (
      <>
        {descriptionField}
        {displayNameField}
        {advancedParamsNode}
      </>
    );
    const createAdvanced = flat
      ? modelChosen && <div className="space-y-4">{advancedFields}</div>
      : modelChosen && (
          <div>
            <button
              type="button"
              aria-expanded={createAdvancedOpen}
              onClick={() => setAdvancedExpanded((v) => !v)}
              className="flex items-center gap-1 text-body-small-default text-[var(--content-secondary)] w-full text-left"
            >
              <ChevronRight
                className={`h-4 w-4 transition-transform ${createAdvancedOpen ? "rotate-90" : ""}`}
              />
              <span>{t("profileEditorFields.advanced")}</span>
            </button>
            {createAdvancedOpen ? (
              <div className="mt-4 space-y-4">{advancedFields}</div>
            ) : null}
          </div>
        );

    // Create asks two questions: which provider, and which model. Everything
    // else has an answer the model supplies, so it waits under Advanced.
    return (
      <div className="space-y-4">
        {createProviderSection}
        {createAdvanced}
        {saveErrorNode}
      </div>
    );
  }

  // Edit / view: Display Name -> Description -> Provider -> Model ->
  // always-visible advanced params.
  return (
    <div className="space-y-4">
      {displayNameField}
      {descriptionField}
      {activeToggle}

      <ProfileEditorProviderSection
        provider={editor.provider}
        model={editor.model}
        providerConnection={editor.providerConnection}
        onProviderChange={editor.handleProviderChange}
        onModelChange={editor.handleModelChange}
        onConnectionChange={editor.handleConnectionChange}
        connections={connections}
        isReadOnly={editor.isReadOnly}
        availableConnectionsForProvider={editor.availableConnectionsForProvider}
        connectionNotFound={editor.connectionNotFound}
        providerError={editor.providerError}
      />

      {advancedParamsNode}

      {saveErrorNode}
    </div>
  );
}

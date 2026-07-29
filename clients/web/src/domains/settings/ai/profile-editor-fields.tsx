import { ChevronRight } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input, Textarea } from "@vellumai/design-library/components/input";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { Typography } from "@vellumai/design-library/components/typography";

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import { OPENAI_COMPATIBLE_PROVIDER } from "@/domains/settings/ai/constants";
import {
  ProfileAdvancedParams,
} from "@/domains/settings/ai/profile-advanced-params";
import {
  PickerMeta,
  ProfileEditorProviderSection,
} from "@/domains/settings/ai/profile-editor-provider-section";
import {
  endpointPickerValue,
  expandEndpointEntries,
  parseEndpointPickerValue,
  providersServedByConnections,
} from "@/domains/settings/ai/provider-availability";
import { ProviderCreateForm } from "@/domains/settings/ai/provider-create-form";
import type { ProfileEditor } from "@/domains/settings/ai/use-profile-editor";
import type {
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import { useActiveAssistantIsSelfHosted } from "@/hooks/use-platform-gate";

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
   * - `"modal"`: the legacy modal layouts - create keeps Key + advanced
   *   params behind a collapsed Advanced disclosure, edit/view shows the
   *   inline Active toggle.
   * - `"panel"`: the settings sidepanel (Figma 7412:134288) - every field
   *   is flat and always visible, and enable/disable lives on the row's
   *   kebab menu instead of an inline toggle.
   */
  variant: "modal" | "panel";
}

/**
 * The profile editor's field stack, shared by the modal host (composer
 * quick-add) and the settings sidepanel. All state lives in the
 * `useProfileEditor` hook; this component only arranges fields per
 * mode/variant. The Name field leads every create layout - it must stay
 * top-level, never inside the Advanced disclosure (LUM-2881).
 */
export function ProfileEditorFields({
  editor,
  assistantId,
  connections,
  variant,
}: ProfileEditorFieldsProps) {
  const activeAssistantIsSelfHosted = useActiveAssistantIsSelfHosted();
  const isCreate = editor.effectiveMode === "create";
  const flat = variant === "panel";

  // Create-mode Advanced disclosure (modal variant only). Local state is
  // fine: hosts remount the fields on each open, matching the old reset.
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const createAdvancedOpen =
    advancedExpanded || (Boolean(editor.keyError) && editor.getDirty());

  const displayNameField = (
    <div className="space-y-1">
      <label className="block text-body-small-default text-[var(--content-tertiary)]">
        {isCreate ? "Name" : "Display Name"}
      </label>
      <Input
        type="text"
        value={editor.label}
        onChange={(e) => editor.handleLabelChange(e.target.value)}
        placeholder="e.g. Fast & Cheap"
        disabled={editor.isReadOnly}
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
      value={editor.description}
      onChange={(e) => editor.setDescription(e.target.value)}
      placeholder="Describe when to use this profile"
      disabled={editor.isReadOnly}
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
        value={editor.key}
        onChange={(e) => editor.handleKeyChange(e.target.value)}
        placeholder="e.g. fast-cheap"
        disabled={editor.isReadOnly || editor.effectiveMode === "edit"}
        fullWidth
      />
      {editor.keyError && !editor.isReadOnly ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-(--system-negative-strong)"
        >
          {editor.keyError}
        </Typography>
      ) : null}
    </div>
  );

  // An active read-only (managed) profile shows no status toggle (it cannot
  // be disabled); a disabled one keeps an enable-only toggle. The panel
  // variant never shows the toggle - enable/disable lives on the row's kebab.
  const activeToggle =
    !flat && (!editor.isReadOnly || editor.status !== "active") ? (
      <Toggle
        checked={editor.status === "active"}
        onChange={(v) => editor.setStatus(v ? "active" : "disabled")}
        label="Active"
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

  const createModeProviderOptions = useMemo(() => {
    const opts: { value: string; label: string; suffix?: ReactNode }[] =
      expandEndpointEntries(
        providersServedByConnections(
          editor.effectiveConnections,
          activeAssistantIsSelfHosted,
        ),
        editor.effectiveConnections,
        (p) => PROVIDER_DISPLAY_NAMES[p] ?? p,
      ).map(({ value, label, meta }) => ({
        value,
        label,
        suffix: meta ? <PickerMeta text={meta} /> : undefined,
      }));
    opts.push({
      value: CREATE_NEW_PROVIDER_SENTINEL,
      label: "+ Create new provider",
    });
    return opts;
  }, [activeAssistantIsSelfHosted, editor.effectiveConnections]);

  const createProviderSection = (
    <div className="space-y-4">
      <div className="space-y-1">
        <label
          id="profile-editor-provider-label"
          className="block text-body-small-default text-[var(--content-tertiary)]"
        >
          Provider
        </label>
        <Dropdown
          value={
            editor.creatingProvider
              ? CREATE_NEW_PROVIDER_SENTINEL
              : editor.provider === OPENAI_COMPATIBLE_PROVIDER &&
                  editor.providerConnection
                ? endpointPickerValue(editor.providerConnection)
                : editor.provider
          }
          onChange={(next) => {
            if (next === CREATE_NEW_PROVIDER_SENTINEL) {
              editor.setCreatingProvider(true);
              editor.setNewProviderNote(false);
              return;
            }
            if (!next) {
              return;
            }
            editor.setCreatingProvider(false);
            const endpoint = parseEndpointPickerValue(next);
            if (endpoint) {
              // Each endpoint entry implies the openai-compatible provider
              // plus its binding; switching endpoints re-picks the model.
              if (editor.provider !== OPENAI_COMPATIBLE_PROVIDER) {
                editor.handleProviderChange(OPENAI_COMPATIBLE_PROVIDER);
              } else {
                editor.setModel("");
              }
              editor.setProviderConnection(endpoint);
              return;
            }
            editor.handleProviderChange(next as ConnectionProvider);
          }}
          placeholder="Select a provider…"
          aria-labelledby="profile-editor-provider-label"
          options={createModeProviderOptions}
        />
        {editor.newProviderNote ? (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-tertiary)]"
          >
            New provider connection will show up in the Providers section.
          </Typography>
        ) : null}
      </div>

      {editor.creatingProvider ? (
        <ProviderCreateForm
          variant="inline"
          assistantId={assistantId}
          existingNames={editor.effectiveConnections.map((c) => c.name)}
          connections={editor.effectiveConnections}
          defaultProviderType={editor.provider || undefined}
          onCreated={editor.handleProviderCreated}
          onCancel={() => editor.setCreatingProvider(false)}
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
    // Advanced only surfaces once a model is chosen: the Key derives from
    // the model, and the model controls the available advanced parameters.
    const modelChosen = editor.model !== "";
    const createAdvanced = flat
      ? modelChosen && (
          <div className="space-y-4">
            {keyField}
            {advancedParamsNode}
          </div>
        )
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
              <span>Advanced</span>
            </button>
            {createAdvancedOpen ? (
              <div className="mt-4 space-y-4">
                {keyField}
                {advancedParamsNode}
              </div>
            ) : null}
          </div>
        );

    // Create is provider-first, with the Name leading the form (LUM-2881).
    return (
      <div className="space-y-4">
        {displayNameField}
        {createProviderSection}
        {descriptionField}
        {activeToggle}
        {createAdvanced}
        {saveErrorNode}
      </div>
    );
  }

  // Edit / view: Display Name -> Description -> Key -> Active (modal only)
  // -> Provider -> Model -> always-visible advanced params.
  return (
    <div className="space-y-4">
      {displayNameField}
      {descriptionField}
      {keyField}
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
      />

      {advancedParamsNode}

      {saveErrorNode}
    </div>
  );
}

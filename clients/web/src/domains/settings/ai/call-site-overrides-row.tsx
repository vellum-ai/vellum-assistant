import { Select } from "@vellumai/design-library/components/select";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { useTranslation } from "@/i18n";

import {
  ALL_CATALOG_MODELS,
  getDefaultModelForProvider,
  getModelsForProvider,
} from "@/assistant/llm-model-catalog";
import type {
  CallSiteOverrideDraft,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

import {
  CUSTOM_SENTINEL,
  isDraftActive,
} from "@/domains/settings/ai/call-site-helpers";
import {
  codexServableModels,
  restrictsToSubscriptionModels,
} from "@/domains/settings/ai/codex-subscription-models";
import { connectionServesProvider } from "@/domains/settings/ai/provider-availability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileOption {
  value: string;
  label: string;
}

export interface CallSiteOverrideRowProps {
  id: string;
  displayName: string;
  description?: string;
  defaultProfileLabel: string | null;
  draft: CallSiteOverrideDraft | null;
  profileOptions: ProfileOption[];
  /**
   * Provider kind of the site's winning route, scoping the custom-pin model
   * picker to what that route can serve. Absent when the winner is
   * indeterminate client-side; the picker then offers the full catalog union
   * and the daemon validates servability on save.
   */
  winningProvider?: string;
  /**
   * All provider connections, used to limit the model picker to what the
   * matching connections can dispatch (a ChatGPT subscription serves only
   * the Codex model set). Absent when the caller has no connection data;
   * the picker then offers the winning provider's full catalog.
   */
  connections?: ProviderConnection[];
  onDraftChange: (id: string, draft: CallSiteOverrideDraft | null) => void;
  onToggle: (id: string, on: boolean) => void;
}

// ---------------------------------------------------------------------------
// CallSiteOverrideRow
// ---------------------------------------------------------------------------

export function CallSiteOverrideRow({
  id,
  displayName,
  description,
  defaultProfileLabel,
  draft,
  profileOptions,
  winningProvider,
  connections,
  onDraftChange,
  onToggle,
}: CallSiteOverrideRowProps) {
  const { t } = useTranslation("settings");
  const overrideOn = isDraftActive(draft);

  const profileVal = (() => {
    if (!draft || !overrideOn) {
      return "";
    }
    // A legacy provider-only pin renders as Custom: picking a model is its
    // repair path (the save clears the provider).
    if (draft.model || draft.provider != null) {
      return CUSTOM_SENTINEL;
    }
    return draft.profile ?? "";
  })();

  const isCustom = profileVal === CUSTOM_SENTINEL;
  // A call-site pin names no connection, so dispatch resolves one from the
  // winning route. When every connection that can serve the winning provider
  // is a ChatGPT subscription (the pre-migration-366 row shape), only Codex
  // models can resolve; offering the rest would save a pin that fails on
  // every request.
  const connectionsForProvider = winningProvider
    ? (connections ?? []).filter((c) =>
        connectionServesProvider(c.provider, winningProvider),
      )
    : [];
  const scopedModels = !winningProvider
    ? ALL_CATALOG_MODELS
    : restrictsToSubscriptionModels(winningProvider, "", connectionsForProvider)
      ? codexServableModels(winningProvider)
      : getModelsForProvider(winningProvider);
  // A winner with an empty catalog (litellm, openai-compatible: models live
  // on the connection) would leave nothing to pick; fall back to the full
  // union and let the daemon validate on save.
  const availableModels =
    scopedModels.length > 0 ? scopedModels : ALL_CATALOG_MODELS;
  const modelOptions = availableModels.map((m) => ({
    value: m.id,
    label: m.displayName,
  }));
  // A stored pin outside the offered set stays visible as itself, marked
  // unavailable: hiding it would render a blank trigger while the pin is
  // still saved.
  const storedModel = typeof draft?.model === "string" ? draft.model : "";
  if (storedModel && !availableModels.some((m) => m.id === storedModel)) {
    const modelDisplayName =
      ALL_CATALOG_MODELS.find((m) => m.id === storedModel)?.displayName ??
      storedModel;
    modelOptions.push({
      value: storedModel,
      label: t("callSiteOverridesRow.unavailableOption", {
        name: modelDisplayName,
      }),
    });
  }

  function handleProfilePickerChange(val: string) {
    if (val === CUSTOM_SENTINEL) {
      // `||` chains so an empty-string catalog default (empty-catalog
      // providers) falls through; a model-less seed would read as an
      // inactive draft.
      const defaultModel =
        (winningProvider
          ? getDefaultModelForProvider(winningProvider)
          : undefined) ||
        availableModels[0]?.id ||
        "";
      onDraftChange(id, { profile: null, model: defaultModel });
    } else if (val === "") {
      onDraftChange(id, null);
    } else {
      onDraftChange(id, { profile: val, model: null });
    }
  }

  function handleModelChange(model: string) {
    onDraftChange(id, { ...(draft ?? {}), model });
  }

  return (
    <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* typography: off-scale — call-site name uses medium weight for visual hierarchy within card */}
          <p className="text-body-medium-default font-medium text-[var(--content-default)]">
            {displayName}
          </p>
          {description && (
            <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
              {description}
              {defaultProfileLabel && (
                <span className="ml-1.5 text-body-small-default text-[var(--content-tertiary)] opacity-60">
                  {t("callSiteOverridesRow.defaultProfileSuffix", {
                    label: defaultProfileLabel,
                  })}
                </span>
              )}
            </p>
          )}
        </div>
        <Toggle
          checked={overrideOn}
          onChange={(on) => onToggle(id, on)}
          aria-label={t("callSiteOverridesRow.overrideAriaLabel", {
            displayName,
          })}
          className="shrink-0"
        />
      </div>

      {overrideOn && (
        <div className="mt-3">
          <Select
            value={profileVal}
            onChange={handleProfilePickerChange}
            options={profileOptions}
            className="w-44"
            menuMinWidth={280}
            menuAlign="start"
          />
        </div>
      )}

      {/* Custom model picker: the route comes from the winning profile */}
      {overrideOn && isCustom && (
        <div className="mt-3 border-t border-[var(--border-base)] pt-3">
          <label className="mb-1 block text-body-small-default text-[var(--content-tertiary)]">
            {t("callSiteOverridesRow.modelLabel")}
          </label>
          <Select
            value={draft?.model ?? ""}
            onChange={handleModelChange}
            options={modelOptions}
          />
        </div>
      )}
    </div>
  );
}

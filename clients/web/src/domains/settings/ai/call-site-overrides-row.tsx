import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Toggle } from "@vellumai/design-library/components/toggle";

import {
  getDefaultModelForProvider,
  getModelsForProvider,
  PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";
import type { CallSiteOverrideDraft } from "@/generated/daemon/types.gen";

import { INFERENCE_PROVIDERS } from "@/domains/settings/ai/constants";
import {
  CUSTOM_SENTINEL,
  isDraftActive,
} from "@/domains/settings/ai/call-site-helpers";
import { useSelectableInferenceProviders } from "@/domains/settings/ai/provider-availability";

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
  onDraftChange,
  onToggle,
}: CallSiteOverrideRowProps) {
  const overrideOn = isDraftActive(draft);

  const profileVal = (() => {
    if (!draft || !overrideOn) return "";
    if (draft.provider || draft.model) return CUSTOM_SENTINEL;
    return draft.profile ?? "";
  })();

  const isCustom = profileVal === CUSTOM_SENTINEL;
  const selectableInferenceProviders = useSelectableInferenceProviders();
  const defaultProvider =
    selectableInferenceProviders[0] ?? INFERENCE_PROVIDERS[0];
  const currentProvider =
    selectableInferenceProviders.find((p) => p === draft?.provider) ??
    defaultProvider;
  const availableModels = getModelsForProvider(currentProvider);
  const modelOptions = availableModels.map((m) => ({
    value: m.id,
    label: m.displayName,
  }));
  const hasModelError = !!draft?.provider && !draft?.model;

  function handleProfilePickerChange(val: string) {
    if (val === CUSTOM_SENTINEL) {
      const defaultModel = getDefaultModelForProvider(defaultProvider) ?? "";
      onDraftChange(id, {
        profile: null,
        provider: defaultProvider,
        model: defaultModel,
      });
    } else if (val === "") {
      onDraftChange(id, null);
    } else {
      onDraftChange(id, { profile: val, provider: null, model: null });
    }
  }

  function handleProviderChange(
    provider: (typeof INFERENCE_PROVIDERS)[number],
  ) {
    const defaultModel = getDefaultModelForProvider(provider) ?? "";
    onDraftChange(id, {
      ...(draft ?? {}),
      profile: null,
      provider,
      model: defaultModel,
    });
  }

  function handleModelChange(model: string) {
    onDraftChange(id, { ...(draft ?? {}), model });
  }

  return (
    <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-3">
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
                  &middot; Default: {defaultProfileLabel}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {overrideOn && (
            <Dropdown
              value={profileVal}
              onChange={handleProfilePickerChange}
              options={profileOptions}
              className="w-44"
              menuMinWidth={280}
              menuAlign="end"
            />
          )}
          <Toggle
            checked={overrideOn}
            onChange={(on) => onToggle(id, on)}
            aria-label={`Override ${displayName}`}
          />
        </div>
      </div>

      {/* Custom provider + model pickers */}
      {overrideOn && isCustom && (
        <div className="mt-3 space-y-2 border-t border-[var(--border-base)] pt-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-body-small-default text-[var(--content-tertiary)]">
                Provider
              </label>
              <Dropdown
                value={currentProvider ?? ""}
                onChange={handleProviderChange}
                options={selectableInferenceProviders.map((p) => ({
                  value: p,
                  label: PROVIDER_DISPLAY_NAMES[p] ?? p,
                }))}
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-body-small-default text-[var(--content-tertiary)]">
                Model
              </label>
              <Dropdown
                value={draft?.model ?? ""}
                onChange={handleModelChange}
                options={modelOptions}
              />
            </div>
          </div>
          {hasModelError && (
            <p className="text-body-small-default text-[var(--system-negative-strong)]">
              Pick a model
            </p>
          )}
        </div>
      )}
    </div>
  );
}

import { Select } from "@vellumai/design-library/components/select";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { useTranslation } from "@/i18n";

import {
  getDefaultModelForProvider,
  getModelsForProvider,
  PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";
import type {
  CallSiteOverrideDraft,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

import {
  CHATGPT_CONNECTION_PROVIDER,
  INFERENCE_PROVIDERS,
  isInferenceProvider,
} from "@/domains/settings/ai/constants";
import {
  CUSTOM_SENTINEL,
  isDraftActive,
} from "@/domains/settings/ai/call-site-helpers";
import {
  codexServableModels,
  restrictsToSubscriptionModels,
} from "@/domains/settings/ai/codex-subscription-models";
import {
  connectionServesProvider,
  useSelectableInferenceProviders,
} from "@/domains/settings/ai/provider-availability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileOption {
  value: string;
  label: string;
}

type PickableProvider =
  (typeof INFERENCE_PROVIDERS)[number] | typeof CHATGPT_CONNECTION_PROVIDER;

export interface CallSiteOverrideRowProps {
  id: string;
  displayName: string;
  description?: string;
  defaultProfileLabel: string | null;
  draft: CallSiteOverrideDraft | null;
  profileOptions: ProfileOption[];
  /**
   * All provider connections, used to limit the model picker to what the
   * matching connections can dispatch (a ChatGPT subscription serves only
   * the Codex model set). Absent when the caller has no connection data;
   * the picker then offers the full catalog.
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
    if (draft.provider || draft.model) {
      return CUSTOM_SENTINEL;
    }
    return draft.profile ?? "";
  })();

  const isCustom = profileVal === CUSTOM_SENTINEL;
  const selectableInferenceProviders = useSelectableInferenceProviders();
  // The chatgpt identity joins the picker when the workspace holds the
  // subscription row (provider "chatgpt"; only daemons that understand the
  // identity return that shape). Migration 144 also writes chatgpt drafts,
  // so the row must represent the value even without the subscription: the
  // unavailable-pin branch below covers that.
  const hasSubscription = (connections ?? []).some(
    (c) => c.provider === CHATGPT_CONNECTION_PROVIDER,
  );
  const pickableProviders: PickableProvider[] = [
    ...selectableInferenceProviders,
    ...(hasSubscription ? ([CHATGPT_CONNECTION_PROVIDER] as const) : []),
  ];
  const defaultProvider =
    selectableInferenceProviders[0] ?? INFERENCE_PROVIDERS[0];
  // Show what is actually pinned, even when this assistant cannot select it
  // (an `ollama` pin on a platform-hosted assistant, say). Substituting a
  // selectable provider for display would show one thing while saving
  // another, and picking the shown value could not repair it: it is already
  // the value, so the change never fires.
  //
  // `LlmProvider` is wider than the picker's domain (it also carries the
  // `openai-compatible` and `vellum` routing sentinels), so a pin outside
  // the pickable set still falls back rather than being offered as a row
  // the picker cannot represent. The `chatgpt` identity is pickable and
  // renders as itself.
  const draftProvider = draft?.provider;
  const storedProvider: PickableProvider | undefined = isInferenceProvider(
    draftProvider,
  )
    ? draftProvider
    : draftProvider === CHATGPT_CONNECTION_PROVIDER
      ? CHATGPT_CONNECTION_PROVIDER
      : undefined;
  const storedProviderIsSelectable =
    storedProvider !== undefined &&
    pickableProviders.some((p) => p === storedProvider);
  const currentProvider = storedProvider ?? defaultProvider;
  // A call-site override pins no connection, so dispatch auto-resolves one.
  // When every connection that can serve the provider is a ChatGPT
  // subscription (stored as provider "chatgpt" once daemon migration 366 has
  // run), only Codex models can resolve; offering the rest would save a pin
  // that fails on every request.
  const connectionsForProvider = (connections ?? []).filter((c) =>
    connectionServesProvider(c.provider, currentProvider),
  );
  const availableModels = restrictsToSubscriptionModels(
    currentProvider,
    "",
    connectionsForProvider,
  )
    ? codexServableModels(currentProvider)
    : getModelsForProvider(currentProvider);
  const modelOptions = availableModels.map((m) => ({
    value: m.id,
    label: m.displayName,
  }));
  // A stored pin outside the offered set stays visible as itself, marked
  // unavailable: hiding it would render a blank trigger while the pin is
  // still saved (mirrors the provider picker's unavailable-pin handling).
  const storedModel = typeof draft?.model === "string" ? draft.model : "";
  if (storedModel && !availableModels.some((m) => m.id === storedModel)) {
    const displayName =
      getModelsForProvider(currentProvider).find((m) => m.id === storedModel)
        ?.displayName ?? storedModel;
    modelOptions.push({
      value: storedModel,
      label: t("callSiteOverridesRow.unavailableOption", { name: displayName }),
    });
  }
  const hasModelError = !!draft?.provider && !draft?.model;
  const providerOptions: { value: PickableProvider; label: string }[] = [
    ...pickableProviders.map((p) => ({
      value: p,
      label: PROVIDER_DISPLAY_NAMES[p] ?? p,
    })),
    // Keeps the trigger honest and gives the user a way out: the row
    // renders its real pin, and choosing any other provider is a genuine
    // change that fires.
    ...(storedProvider && !storedProviderIsSelectable
      ? [
          {
            value: storedProvider,
            label: t("callSiteOverridesRow.unavailableOption", {
              name:
                PROVIDER_DISPLAY_NAMES[storedProvider] ?? storedProvider,
            }),
          },
        ]
      : []),
  ];

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

  function handleProviderChange(provider: PickableProvider) {
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

      {/* Custom provider + model pickers */}
      {overrideOn && isCustom && (
        <div className="mt-3 space-y-2 border-t border-[var(--border-base)] pt-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-body-small-default text-[var(--content-tertiary)]">
                {t("callSiteOverridesRow.providerLabel")}
              </label>
              <Select
                value={currentProvider ?? ""}
                onChange={handleProviderChange}
                options={providerOptions}
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-body-small-default text-[var(--content-tertiary)]">
                {t("callSiteOverridesRow.modelLabel")}
              </label>
              <Select
                value={draft?.model ?? ""}
                onChange={handleModelChange}
                options={modelOptions}
              />
            </div>
          </div>
          {hasModelError && (
            <p className="text-body-small-default text-[var(--system-negative-strong)]">
              {t("callSiteOverridesRow.pickModelError")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { Select } from "@vellumai/design-library/components/select";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

import {
  LS_IMAGE_GEN_MODEL,
  LS_IMAGE_GEN_PROVIDER,
} from "@/utils/local-settings-keys";
import {
  IMAGE_GEN_PROVIDER_DISPLAY_NAMES,
  IMAGE_GEN_PROVIDERS,
  IMAGE_GEN_MODEL_DISPLAY_NAMES,
  imageGenModelsForProvider,
  providerForImageGenModel,
} from "@/lib/provider-catalogs";

import { ByoServiceCard } from "@/domains/settings/ai/shared-ui";
import { ResetButton, SaveButton } from "@/components/service-form-controls";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
import { useProvisionProviderKey } from "@/domains/settings/ai/use-daemon-config";
import {
  credentialPresenceQueryKey,
  useStoredCredentialPresence,
} from "@/domains/settings/ai/use-stored-credential-presence";
import {
  configGetOptions,
  configGetQueryKey,
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useQuery } from "@tanstack/react-query";
import { useDraftOverride } from "@/hooks/use-draft-override";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { modelImagegenPut } from "@/generated/daemon/sdk.gen";
import { supportsImageGenVellumProvider } from "@/lib/backwards-compat/use-supports-image-gen-vellum-provider";
import { whenAssistantVersionKnown } from "@/lib/backwards-compat/utils";

const DEFAULT_IMAGE_GEN_MODEL = "gemini-3.1-flash-image-preview";

export function ImageGenerationCard() {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const isOrgReady = useIsOrgReady();

  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: 30_000,
  });

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        data,
      );
    },
  });
  const provisionProviderKey = useProvisionProviderKey();

  // Server value derived from daemon config, falling back to localStorage.
  // Updates automatically when the cache refreshes.
  const serverProvider = useMemo((): string => {
    if (!daemonConfig) {
      return getLocalSetting(LS_IMAGE_GEN_PROVIDER, "gemini");
    }
    const svc = daemonConfig.services?.["image-generation"] as
      { provider?: string; mode?: string } | undefined;
    // A config written by the legacy mode toggle marks managed via `mode` —
    // the daemon routes it to Vellum, so the card renders it as Vellum too.
    if (svc?.mode === "managed") {
      return "vellum";
    }
    return svc?.provider || getLocalSetting(LS_IMAGE_GEN_PROVIDER, "gemini");
  }, [daemonConfig]);

  const [provider, setDraftProvider] = useDraftOverride(serverProvider);

  const [imageGenModel, setImageGenModel] = useState(() =>
    getLocalSetting(LS_IMAGE_GEN_MODEL, DEFAULT_IMAGE_GEN_MODEL),
  );
  // Reconcile the stored model against the provider's list on every render,
  // not just on a provider change — a stale stored model (e.g. gpt-image-2
  // under a Gemini config) must never reach a save or a key provisioning.
  const providerModels = imageGenModelsForProvider(provider);
  const effectiveModel = providerModels.includes(imageGenModel)
    ? imageGenModel
    : (providerModels[0] ?? DEFAULT_IMAGE_GEN_MODEL);
  const [imageGenApiKey, setImageGenApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const providerOptions = IMAGE_GEN_PROVIDERS.map((id) => ({
    value: id,
    label: IMAGE_GEN_PROVIDER_DISPLAY_NAMES[id] ?? id,
  }));

  const modelOptions = useMemo(
    () =>
      imageGenModelsForProvider(provider).map((model) => ({
        value: model,
        label: IMAGE_GEN_MODEL_DISPLAY_NAMES[model] ?? model,
      })),
    [provider],
  );

  const requiresApiKey = provider === "gemini" || provider === "openai";

  const { hasStoredCredential: imageGenHasStoredKey } =
    useStoredCredentialPresence({
      assistantId,
      credentialKind: "api_key",
      credentialName: provider,
      enabled: requiresApiKey,
    });

  // Model reconciliation is derived (`effectiveModel`), so a provider change
  // needs no imperative snap.
  const handleProviderChange = setDraftProvider;

  const handleSave = useCallback(async () => {
    setSaving(true);
    const trimmed = imageGenApiKey.trim();
    const hasUserKey = requiresApiKey && trimmed.length > 0;
    try {
      if (hasUserKey) {
        await provisionProviderKey(
          providerForImageGenModel(effectiveModel),
          trimmed,
        );
      }
      // The provider is written as a pair with `mode`: a stale
      // `mode: "managed"` from the legacy toggle would win over a BYOK choice
      // unless reset. Only the `vellum` value is unrepresentable on daemons
      // older than its enum entry — for those a Vellum selection writes the
      // legacy managed mode alone (the read bridge renders that pair as
      // Vellum), while BYOK providers keep their explicit provider write.
      await whenAssistantVersionKnown();
      const vellumUnsupported =
        provider === "vellum" && !supportsImageGenVellumProvider();
      const imageGenService: {
        provider?: string;
        mode: "managed" | "your-own";
      } = vellumUnsupported
        ? { mode: "managed" }
        : {
            provider,
            mode: provider === "vellum" ? "managed" : "your-own",
          };
      await configMutation
        .mutateAsync({
          path: { assistant_id: assistantId },
          body: { services: { "image-generation": imageGenService } },
        })
        .catch((error) => {
          toast.error(t("imageGenerationCard.configUpdateFailedToast"));
          captureError(error, { context: "patch_daemon_config" });
          throw error;
        });
      try {
        await modelImagegenPut({
          path: { assistant_id: assistantId },
          body: { modelId: effectiveModel },
          throwOnError: true,
        });
      } catch (error) {
        toast.error(t("imageGenerationCard.modelUpdateFailedToast"));
        captureError(error, { context: "set_image_gen_model" });
        throw error;
      } finally {
        void queryClient.invalidateQueries({
          queryKey: configGetQueryKey({ path: { assistant_id: assistantId } }),
        });
      }
    } catch {
      setSaving(false);
      return;
    }
    setSaving(false);
    try {
      setLocalSetting(LS_IMAGE_GEN_PROVIDER, provider);
      setLocalSetting(LS_IMAGE_GEN_MODEL, effectiveModel);
      if (hasUserKey) {
        // Optimistic update: mark key as stored immediately, then
        // background-refetch confirms server state.
        const presenceKey = credentialPresenceQueryKey(
          assistantId,
          "api_key",
          provider,
        );
        queryClient.setQueryData(presenceKey, true);
        void queryClient.invalidateQueries({ queryKey: presenceKey });
        setImageGenApiKey("");
      }
      toast.success(t("imageGenerationCard.savedToast"));
    } catch (err) {
      captureError(err, { context: "settings-ai-image-gen-persist-local" });
      toast.error(t("imageGenerationCard.localPreferencesFailedToast"));
    }
  }, [
    imageGenApiKey,
    provider,
    requiresApiKey,
    effectiveModel,
    assistantId,
    configMutation,
    provisionProviderKey,
    queryClient,
    t,
  ]);

  const handleReset = useCallback(() => {
    setImageGenApiKey("");
    setImageGenModel(DEFAULT_IMAGE_GEN_MODEL);
    setLocalSetting(LS_IMAGE_GEN_MODEL, DEFAULT_IMAGE_GEN_MODEL);
  }, []);

  return (
    <ByoServiceCard
      title={t("imageGenerationCard.title")}
      subtitle={t("imageGenerationCard.subtitle")}
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            {t("imageGenerationCard.providerLabel")}
          </label>
          <Select
            aria-label={t("imageGenerationCard.providerAriaLabel")}
            value={provider}
            onChange={handleProviderChange}
            options={providerOptions}
          />
        </div>

        {provider === "vellum" && (
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("imageGenerationCard.vellumNote")}
          </p>
        )}

        {requiresApiKey && (
          <Input
            label={t("imageGenerationCard.apiKeyLabel")}
            type="password"
            value={imageGenApiKey}
            onChange={(e) => setImageGenApiKey(e.target.value)}
            placeholder={secretPlaceholder(
              provider === "openai"
                ? t("imageGenerationCard.openaiApiKeyPlaceholder")
                : t("imageGenerationCard.geminiApiKeyPlaceholder"),
              imageGenHasStoredKey,
            )}
            fullWidth
          />
        )}

        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            {t("imageGenerationCard.activeModelLabel")}
          </label>
          <Select
            aria-label={t("imageGenerationCard.modelAriaLabel")}
            value={effectiveModel}
            onChange={setImageGenModel}
            options={modelOptions}
          />
        </div>

        <div className="flex items-center gap-2">
          <SaveButton onClick={handleSave} disabled={saving} />
          {saving && (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
          )}
          {requiresApiKey && <ResetButton onClick={handleReset} />}
        </div>
      </div>
    </ByoServiceCard>
  );
}

import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  WEB_SEARCH_API_BASE_PROVIDER_IDS,
  WEB_SEARCH_BYOK_PROVIDER_IDS,
  WEB_SEARCH_KEYLESS_BYOK_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_DEFAULT_API_BASE,
  WEB_SEARCH_PROVIDER_DISPLAY_NAMES,
  WEB_SEARCH_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS,
} from "@/assistant/generated/web-search-provider-catalog.gen";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";
import { useQueryClient } from "@tanstack/react-query";
import { Select } from "@vellumai/design-library/components/select";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

import { ByoServiceCard } from "@/components/byo-service-card";
import { ResetButton, SaveButton } from "@/components/service-form-controls";
import { LS_WEB_SEARCH_PROVIDER } from "@/utils/local-settings-keys";
import { getWebSearchProviderKeyStorage } from "@/domains/settings/ai/utils";
import { useProvisionProviderKey } from "@/domains/settings/ai/use-daemon-config";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  configGetOptions,
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useQuery } from "@tanstack/react-query";
import { useDraftOverride } from "@/hooks/use-draft-override";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  credentialPresenceQueryKey,
  useStoredCredentialPresence,
} from "@/domains/settings/ai/use-stored-credential-presence";
import { supportsWebSearchVellumProvider } from "@/lib/backwards-compat/use-supports-web-search-vellum-provider";
import { whenAssistantVersionKnown } from "@/lib/backwards-compat/utils";

export function WebSearchCard() {
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
  // When the cache refreshes (after save + invalidation), this updates
  // automatically.
  const serverWebSearchProvider = useMemo((): string => {
    if (!daemonConfig) {
      return getLocalSetting(
        LS_WEB_SEARCH_PROVIDER,
        "inference-provider-native",
      );
    }
    const wsService = daemonConfig.services?.["web-search"] as
      | { provider?: string; mode?: string; apiBase?: string }
      | undefined;
    // A config written by the legacy mode toggle marks managed via `mode`
    // while `provider` holds the BYOK restore value — the daemon routes it to
    // Vellum, so the card must render it as Vellum too. Provider Native is
    // exempt: it stays itself under managed mode (see migration 132).
    const daemonProvider =
      wsService?.mode === "managed" &&
      wsService?.provider !== "inference-provider-native"
        ? "vellum"
        : wsService?.provider;
    return (
      daemonProvider ||
      getLocalSetting(LS_WEB_SEARCH_PROVIDER, "inference-provider-native")
    );
  }, [daemonConfig]);

  const serverApiBase = useMemo((): string => {
    const wsService = daemonConfig?.services?.["web-search"] as
      | { apiBase?: string }
      | undefined;
    return wsService?.apiBase ?? "";
  }, [daemonConfig]);

  const [saving, setSaving] = useState(false);
  const [webSearchProvider, setDraftWebSearchProvider] = useDraftOverride(
    serverWebSearchProvider,
  );
  const [webSearchApiBase, setDraftWebSearchApiBase] =
    useDraftOverride(serverApiBase);

  const [webSearchApiKey, setWebSearchApiKey] = useState("");

  const showsApiBase = WEB_SEARCH_API_BASE_PROVIDER_IDS.has(webSearchProvider);
  const requiresProviderCredential =
    WEB_SEARCH_BYOK_PROVIDER_IDS.has(webSearchProvider);
  const isKeylessByok =
    WEB_SEARCH_KEYLESS_BYOK_PROVIDER_IDS.has(webSearchProvider);
  const { hasStoredCredential: webSearchHasStoredKey } =
    useStoredCredentialPresence({
      assistantId,
      credentialKind: "api_key",
      credentialName: webSearchProvider,
      enabled: requiresProviderCredential,
    });

  // --- Derived state ---
  const hasNewApiKey = webSearchApiKey.trim().length > 0;
  const trimmedApiBase = webSearchApiBase.trim();
  const hasCustomApiBase = showsApiBase && trimmedApiBase.length > 0;
  const configChanged =
    webSearchProvider !== serverWebSearchProvider ||
    (showsApiBase && trimmedApiBase !== serverApiBase.trim());
  const needsKeyBeforeSave =
    requiresProviderCredential &&
    !isKeylessByok &&
    !hasCustomApiBase &&
    !webSearchHasStoredKey &&
    !hasNewApiKey;
  const saveDisabled =
    saving || needsKeyBeforeSave || (!configChanged && !hasNewApiKey);
  const apiKeyPlaceholder = secretPlaceholder(
    WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS[webSearchProvider] ??
      t("webSearchCard.apiKeyPlaceholder"),
    webSearchHasStoredKey,
  );
  const defaultApiBase =
    WEB_SEARCH_PROVIDER_DEFAULT_API_BASE[webSearchProvider] ?? "";

  const handleSave = useCallback(async () => {
    setSaving(true);
    const trimmed = webSearchApiKey.trim();
    const storageKey = getWebSearchProviderKeyStorage(webSearchProvider);
    const hasUserKey = requiresProviderCredential && trimmed.length > 0;
    try {
      if (hasUserKey) {
        await provisionProviderKey(webSearchProvider, trimmed);
      }
      // The provider is written as a pair with `mode`: a stale
      // `mode: "managed"` from the legacy toggle would win over a BYOK
      // choice unless reset. Daemons older than the vellum catalog entry
      // reject the provider value outright, so for them a Vellum selection
      // writes only the legacy managed mode and lets the deep-merge keep the
      // stored provider — the read bridge renders that pair as Vellum again.
      await whenAssistantVersionKnown();
      const webSearchService: {
        provider?: string;
        mode: "managed" | "your-own";
        apiBase?: string;
      } =
        webSearchProvider === "vellum"
          ? supportsWebSearchVellumProvider()
            ? { provider: "vellum", mode: "managed" }
            : { mode: "managed" }
          : {
              provider: webSearchProvider,
              mode: "your-own",
              ...(showsApiBase ? { apiBase: trimmedApiBase } : {}),
            };
      await configMutation
        .mutateAsync({
          path: { assistant_id: assistantId },
          body: {
            services: {
              "web-search": webSearchService,
            },
          },
        })
        .catch((error) => {
          toast.error(t("webSearchCard.configUpdateFailedToast"));
          captureError(error, { context: "patch_daemon_config" });
          throw error;
        });
    } catch {
      setSaving(false);
      return;
    }
    setSaving(false);
    try {
      setLocalSetting(LS_WEB_SEARCH_PROVIDER, webSearchProvider);
      if (hasUserKey) {
        if (storageKey) {
          setLocalSetting(storageKey, trimmed);
        }
        // Optimistic update: mark key as stored immediately, then
        // background-refetch confirms server state.
        const presenceKey = credentialPresenceQueryKey(
          assistantId,
          "api_key",
          webSearchProvider,
        );
        queryClient.setQueryData(presenceKey, true);
        void queryClient.invalidateQueries({ queryKey: presenceKey });
        setWebSearchApiKey("");
      }
      toast.success(t("webSearchCard.savedToast"));
    } catch (err) {
      captureError(err, { context: "settings-ai-web-search-persist-local" });
      toast.error(t("webSearchCard.localPreferencesFailedToast"));
    }
  }, [
    requiresProviderCredential,
    configMutation,
    provisionProviderKey,
    queryClient,
    assistantId,
    webSearchApiKey,
    webSearchProvider,
    showsApiBase,
    trimmedApiBase,
    t,
  ]);

  const handleReset = useCallback(() => {
    const storageKey = getWebSearchProviderKeyStorage(webSearchProvider);
    if (storageKey) {
      removeLocalSetting(storageKey);
    }
    setWebSearchApiKey("");
    setDraftWebSearchApiBase("");
    setDraftWebSearchProvider("inference-provider-native");
    setLocalSetting(LS_WEB_SEARCH_PROVIDER, "inference-provider-native");
  }, [
    webSearchProvider,
    setDraftWebSearchProvider,
    setDraftWebSearchApiBase,
  ]);

  return (
    <ByoServiceCard
      title={t("webSearchCard.title")}
      subtitle={t("webSearchCard.subtitle")}
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            {t("webSearchCard.providerLabel")}
          </label>
          <Select
            aria-label={t("webSearchCard.providerAriaLabel")}
            value={webSearchProvider}
            onChange={setDraftWebSearchProvider}
            options={WEB_SEARCH_PROVIDER_IDS.map((p) => ({
              value: p,
              label: WEB_SEARCH_PROVIDER_DISPLAY_NAMES[p] ?? p,
            }))}
          />
        </div>

        {webSearchProvider === "vellum" && (
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("webSearchCard.vellumNote")}
          </p>
        )}

        {showsApiBase && (
          <div className="space-y-1">
            <Input
              label={t("webSearchCard.apiBaseLabel")}
              type="url"
              value={webSearchApiBase}
              onChange={(e) => setDraftWebSearchApiBase(e.target.value)}
              placeholder={
                defaultApiBase || t("webSearchCard.apiBasePlaceholder")
              }
              fullWidth
            />
            {defaultApiBase ? (
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                {t("webSearchCard.apiBaseHint", {
                  defaultBase: defaultApiBase,
                })}
              </p>
            ) : null}
          </div>
        )}

        {requiresProviderCredential && (
          <Input
            label={t("webSearchCard.apiKeyLabel")}
            type="password"
            value={webSearchApiKey}
            onChange={(e) => setWebSearchApiKey(e.target.value)}
            placeholder={apiKeyPlaceholder}
            fullWidth
          />
        )}

        <div className="flex items-center gap-2">
          <SaveButton onClick={handleSave} disabled={saveDisabled} />
          {saving && (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
          )}
          {requiresProviderCredential && (
            <ResetButton onClick={handleReset} filled />
          )}
        </div>
      </div>
    </ByoServiceCard>
  );
}

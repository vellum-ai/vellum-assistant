import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  WEB_SEARCH_BYOK_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_DISPLAY_NAMES,
  WEB_SEARCH_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS,
} from "@/assistant/generated/web-search-provider-catalog.gen";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
import { captureError } from "@/lib/sentry/capture-error";
import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";
import { useQueryClient } from "@tanstack/react-query";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

import { ByoServiceCard } from "@/domains/settings/ai/shared-ui";
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
      { provider?: string; mode?: string } | undefined;
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

  const [saving, setSaving] = useState(false);
  const [webSearchProvider, setDraftWebSearchProvider] = useDraftOverride(
    serverWebSearchProvider,
  );

  const [webSearchApiKey, setWebSearchApiKey] = useState("");

  const requiresProviderCredential =
    WEB_SEARCH_BYOK_PROVIDER_IDS.has(webSearchProvider);
  const { hasStoredCredential: webSearchHasStoredKey } =
    useStoredCredentialPresence({
      assistantId,
      credentialKind: "api_key",
      credentialName: webSearchProvider,
      enabled: requiresProviderCredential,
    });

  // --- Derived state ---
  const hasNewApiKey = webSearchApiKey.trim().length > 0;
  const configChanged = webSearchProvider !== serverWebSearchProvider;
  const needsKeyBeforeSave =
    requiresProviderCredential && !webSearchHasStoredKey && !hasNewApiKey;
  const saveDisabled =
    saving || needsKeyBeforeSave || (!configChanged && !hasNewApiKey);
  const apiKeyPlaceholder = secretPlaceholder(
    WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS[webSearchProvider] ??
      "Enter your API key",
    webSearchHasStoredKey,
  );

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
      } =
        webSearchProvider === "vellum"
          ? supportsWebSearchVellumProvider()
            ? { provider: "vellum", mode: "managed" }
            : { mode: "managed" }
          : { provider: webSearchProvider, mode: "your-own" };
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
          toast.error(
            "Failed to update assistant configuration. Please try again.",
          );
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
      toast.success("Web search settings saved.");
    } catch (err) {
      captureError(err, { context: "settings-ai-web-search-persist-local" });
      toast.error("Saved, but local preferences could not be written.");
    }
  }, [
    requiresProviderCredential,
    configMutation,
    provisionProviderKey,
    queryClient,
    assistantId,
    webSearchApiKey,
    webSearchProvider,
  ]);

  const handleReset = useCallback(() => {
    const storageKey = getWebSearchProviderKeyStorage(webSearchProvider);
    if (storageKey) {
      removeLocalSetting(storageKey);
    }
    setWebSearchApiKey("");
    setDraftWebSearchProvider("inference-provider-native");
    setLocalSetting(LS_WEB_SEARCH_PROVIDER, "inference-provider-native");
  }, [webSearchProvider, setDraftWebSearchProvider]);

  return (
    <ByoServiceCard
      title="Web Search"
      subtitle="Configure how your assistant should search the web"
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Provider
          </label>
          <Dropdown
            aria-label="Web search provider"
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
            Search runs through your Vellum account.
          </p>
        )}

        {requiresProviderCredential && (
          <Input
            label="API Key"
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

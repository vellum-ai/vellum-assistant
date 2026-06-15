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

import { ResetButton, SaveButton, ServiceCard } from "@/domains/settings/ai/shared-ui";
import { LS_WEB_SEARCH_MODE, LS_WEB_SEARCH_PROVIDER } from "@/domains/settings/ai/local-storage-keys";
import { getWebSearchProviderKeyStorage, parseServiceMode } from "@/domains/settings/ai/utils";
import type { ServiceMode } from "@/generated/daemon/types.gen";
import { useProvisionProviderKey } from "@/domains/settings/ai/use-daemon-config";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { configGetOptions, configGetSetQueryData, useConfigPatchMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useQuery } from "@tanstack/react-query";
import { useDraftOverride } from "@/domains/settings/ai/use-draft-override";
import { credentialPresenceQueryKey, useStoredCredentialPresence } from "@/domains/settings/ai/use-stored-credential-presence";

export function WebSearchCard() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(queryClient, { path: { assistant_id: assistantId } }, data);
    },
  });
  const provisionProviderKey = useProvisionProviderKey();

  // Server values derived from daemon config, falling back to localStorage.
  // When the cache refreshes (after save + invalidation), these update
  // automatically.
  const { serverWebSearchMode, serverWebSearchProvider } = useMemo((): {
    serverWebSearchMode: ServiceMode;
    serverWebSearchProvider: string;
  } => {
    if (!daemonConfig) {
      return {
        serverWebSearchMode: parseServiceMode(getLocalSetting(LS_WEB_SEARCH_MODE, "your-own"), "your-own"),
        serverWebSearchProvider: getLocalSetting(LS_WEB_SEARCH_PROVIDER, "inference-provider-native"),
      };
    }
    const wsService = daemonConfig.services?.["web-search"];
    return {
      serverWebSearchMode: parseServiceMode(
        wsService?.mode ?? getLocalSetting(LS_WEB_SEARCH_MODE, "your-own"),
        "your-own",
      ),
      serverWebSearchProvider: wsService?.provider || getLocalSetting(LS_WEB_SEARCH_PROVIDER, "inference-provider-native"),
    };
  }, [daemonConfig]);

  const [saving, setSaving] = useState(false);
  const [webSearchMode, setDraftWebSearchMode] = useDraftOverride(serverWebSearchMode);
  const [webSearchProvider, setDraftWebSearchProvider] = useDraftOverride(serverWebSearchProvider);

  const [webSearchApiKey, setWebSearchApiKey] = useState("");

  const requiresProviderCredential = WEB_SEARCH_BYOK_PROVIDER_IDS.has(webSearchProvider);
  const { hasStoredCredential: webSearchHasStoredKey } =
    useStoredCredentialPresence({
      assistantId,
      credentialKind: "api_key",
      credentialName: webSearchProvider,
      enabled: requiresProviderCredential,
    });

  // --- Derived state ---
  const hasNewApiKey = webSearchApiKey.trim().length > 0;
  const effectiveProvider =
    webSearchMode === "managed" ? "inference-provider-native" : webSearchProvider;
  const configChanged =
    webSearchMode !== serverWebSearchMode ||
    effectiveProvider !== serverWebSearchProvider;
  const needsKeyBeforeSave =
    webSearchMode === "your-own" &&
    requiresProviderCredential &&
    !webSearchHasStoredKey &&
    !hasNewApiKey;
  const saveDisabled =
    saving || needsKeyBeforeSave || (!configChanged && !hasNewApiKey);
  const apiKeyPlaceholder = secretPlaceholder(
    WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS[webSearchProvider] ?? "Enter your API key",
    webSearchHasStoredKey,
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    const trimmed = webSearchApiKey.trim();
    const providerToSave =
      webSearchMode === "managed" ? "inference-provider-native" : webSearchProvider;
    const storageKey = getWebSearchProviderKeyStorage(providerToSave);
    const hasUserKey =
      webSearchMode === "your-own" && requiresProviderCredential && trimmed.length > 0;
    try {
      if (hasUserKey) {
        await provisionProviderKey(providerToSave, trimmed);
      }
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: {
          services: {
            "web-search": { mode: webSearchMode, provider: providerToSave },
          },
        },
      }).catch((error) => {
        toast.error("Failed to update assistant configuration. Please try again.");
        captureError(error, { context: "patch_daemon_config" });
        throw error;
      });
    } catch {
      setSaving(false);
      return;
    }
    setSaving(false);
    try {
      setLocalSetting(LS_WEB_SEARCH_MODE, webSearchMode);
      setLocalSetting(LS_WEB_SEARCH_PROVIDER, providerToSave);
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
    webSearchMode,
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
    <ServiceCard
      title="Web Search"
      subtitle="Configure how your assistant should search the web"
      mode={webSearchMode}
      onModeChange={(m) => setDraftWebSearchMode(m)}
    >
      {webSearchMode === "managed" ? (
        <div className="space-y-3">
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            Web search is included with managed inference.
          </p>
          <div className="flex items-center gap-2">
            <SaveButton onClick={handleSave} disabled={saveDisabled} />
            {saving && <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Provider
            </label>
            <Dropdown
              value={webSearchProvider}
              onChange={setDraftWebSearchProvider}
              options={WEB_SEARCH_PROVIDER_IDS.map((p) => ({
                value: p,
                label: WEB_SEARCH_PROVIDER_DISPLAY_NAMES[p] ?? p,
              }))}
            />
          </div>

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
            {saving && <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />}
            {requiresProviderCredential && (
              <ResetButton onClick={handleReset} filled />
            )}
          </div>
        </div>
      )}
    </ServiceCard>
  );
}

import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
    WEB_FETCH_BYOK_PROVIDER_IDS,
    WEB_FETCH_PROVIDER_DISPLAY_NAMES,
    WEB_FETCH_PROVIDER_IDS,
    WEB_FETCH_PROVIDER_KEY_PLACEHOLDERS,
} from "@/assistant/generated/web-fetch-provider-catalog.gen";
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

import { ByoServiceCard, ResetButton, SaveButton } from "@/domains/settings/ai/shared-ui";
import { LS_WEB_FETCH_PROVIDER } from "@/domains/settings/ai/local-storage-keys";
import { getWebFetchProviderKeyStorage } from "@/domains/settings/ai/utils";
import { useProvisionProviderKey } from "@/domains/settings/ai/use-daemon-config";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { configGetOptions, configGetSetQueryData, useConfigPatchMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useQuery } from "@tanstack/react-query";
import { useDraftOverride } from "@/domains/settings/ai/use-draft-override";
import { credentialPresenceQueryKey, useStoredCredentialPresence } from "@/domains/settings/ai/use-stored-credential-presence";

const DEFAULT_PROVIDER = "default";

/**
 * Web Fetch service card. Unlike Web Search there is no managed proxy, so the
 * card is mode-less (`ByoServiceCard`): pick the built-in fetcher or a BYOK
 * provider (Firecrawl) that scrapes via its hosted API. Firecrawl reuses the
 * same stored credential as Web Search.
 */
export function WebFetchCard() {
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

  // Server value derived from daemon config, falling back to localStorage.
  const serverWebFetchProvider = useMemo((): string => {
    if (!daemonConfig) {
      return getLocalSetting(LS_WEB_FETCH_PROVIDER, DEFAULT_PROVIDER);
    }
    const service = daemonConfig.services?.["web-fetch"];
    return service?.provider || getLocalSetting(LS_WEB_FETCH_PROVIDER, DEFAULT_PROVIDER);
  }, [daemonConfig]);

  const [saving, setSaving] = useState(false);
  const [webFetchProvider, setDraftWebFetchProvider] = useDraftOverride(serverWebFetchProvider);
  const [webFetchApiKey, setWebFetchApiKey] = useState("");

  const requiresProviderCredential = WEB_FETCH_BYOK_PROVIDER_IDS.has(webFetchProvider);
  const { hasStoredCredential: webFetchHasStoredKey } =
    useStoredCredentialPresence({
      assistantId,
      credentialKind: "api_key",
      credentialName: webFetchProvider,
      enabled: requiresProviderCredential,
    });

  // --- Derived state ---
  const hasNewApiKey = webFetchApiKey.trim().length > 0;
  const configChanged = webFetchProvider !== serverWebFetchProvider;
  const needsKeyBeforeSave =
    requiresProviderCredential && !webFetchHasStoredKey && !hasNewApiKey;
  const saveDisabled =
    saving || needsKeyBeforeSave || (!configChanged && !hasNewApiKey);
  const apiKeyPlaceholder = secretPlaceholder(
    WEB_FETCH_PROVIDER_KEY_PLACEHOLDERS[webFetchProvider] ?? "Enter your API key",
    webFetchHasStoredKey,
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    const trimmed = webFetchApiKey.trim();
    const hasUserKey = requiresProviderCredential && trimmed.length > 0;
    try {
      if (hasUserKey) {
        await provisionProviderKey(webFetchProvider, trimmed);
      }
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: {
          services: {
            "web-fetch": { provider: webFetchProvider },
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
      setLocalSetting(LS_WEB_FETCH_PROVIDER, webFetchProvider);
      if (hasUserKey) {
        const storageKey = getWebFetchProviderKeyStorage(webFetchProvider);
        if (storageKey) {
          setLocalSetting(storageKey, trimmed);
        }
        const presenceKey = credentialPresenceQueryKey(
          assistantId,
          "api_key",
          webFetchProvider,
        );
        queryClient.setQueryData(presenceKey, true);
        void queryClient.invalidateQueries({ queryKey: presenceKey });
        setWebFetchApiKey("");
      }
      toast.success("Web fetch settings saved.");
    } catch (err) {
      captureError(err, { context: "settings-ai-web-fetch-persist-local" });
      toast.error("Saved, but local preferences could not be written.");
    }
  }, [
    requiresProviderCredential,
    configMutation,
    provisionProviderKey,
    queryClient,
    assistantId,
    webFetchApiKey,
    webFetchProvider,
  ]);

  const handleReset = useCallback(() => {
    const storageKey = getWebFetchProviderKeyStorage(webFetchProvider);
    if (storageKey) {
      removeLocalSetting(storageKey);
    }
    setWebFetchApiKey("");
    setDraftWebFetchProvider(DEFAULT_PROVIDER);
    setLocalSetting(LS_WEB_FETCH_PROVIDER, DEFAULT_PROVIDER);
  }, [webFetchProvider, setDraftWebFetchProvider]);

  return (
    <ByoServiceCard
      id="web-fetch"
      title="Web Fetch"
      subtitle="Configure how your assistant reads individual web pages"
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Provider
          </label>
          <Dropdown
            value={webFetchProvider}
            onChange={setDraftWebFetchProvider}
            options={WEB_FETCH_PROVIDER_IDS.map((p) => ({
              value: p,
              label: WEB_FETCH_PROVIDER_DISPLAY_NAMES[p] ?? p,
            }))}
          />
        </div>

        {requiresProviderCredential && (
          <Input
            label="API Key"
            type="password"
            value={webFetchApiKey}
            onChange={(e) => setWebFetchApiKey(e.target.value)}
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
    </ByoServiceCard>
  );
}

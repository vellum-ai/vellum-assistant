import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";
import { toast } from "@vellum/design-library/components/toast";
import {
  WEB_SEARCH_BYOK_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_DISPLAY_NAMES,
  WEB_SEARCH_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS,
} from "@/assistant/generated/web-search-provider-catalog.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { secretsReadPost } from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";

import type { ServiceMode } from "@/domains/settings/ai/ai-types";
import { LS_WEB_SEARCH_MODE, LS_WEB_SEARCH_PROVIDER } from "@/domains/settings/ai/ai-types";
import { getWebSearchProviderKeyStorage, reconcileFromDaemonConfig } from "@/domains/settings/ai/ai-utils";
import { ServiceCard, SaveButton, ResetButton } from "@/domains/settings/ai/ai-shared-ui";
import { useDaemonConfigQuery, useDaemonConfigMutation, useProvisionProviderKey } from "@/domains/settings/ai/use-daemon-config";

// ---------------------------------------------------------------------------
// Query key for the stored-credential presence check
// ---------------------------------------------------------------------------

const WEB_SEARCH_CREDENTIAL_QK = "web-search-credential" as const;

function webSearchCredentialQueryKey(
  assistantId: string | null | undefined,
  provider: string,
) {
  return [WEB_SEARCH_CREDENTIAL_QK, assistantId ?? "", provider] as const;
}

export function WebSearchCard() {
  const {
    assistantId,
    config: daemonConfig,
  } = useDaemonConfigQuery();
  const configMutation = useDaemonConfigMutation();
  const provisionProviderKey = useProvisionProviderKey();
  const queryClient = useQueryClient();

  // --- Form state (local, unsaved) ---
  const [saving, setSaving] = useState(false);
  const [webSearchMode, setWebSearchMode] = useState<ServiceMode>(
    () => getLocalSetting(LS_WEB_SEARCH_MODE, "your-own") as ServiceMode,
  );
  const [webSearchProvider, setWebSearchProvider] = useState(() =>
    getLocalSetting(LS_WEB_SEARCH_PROVIDER, "inference-provider-native"),
  );
  const [webSearchApiKey, setWebSearchApiKey] = useState("");

  // --- Saved state derived from daemon config ---
  // Optimistic override bridges the gap between a successful save and the
  // async daemon config refetch. Without it, savedWebSearch* would reflect
  // stale config during the refetch window, making configChanged=true and
  // briefly re-enabling the save button.
  const [savedOverride, setSavedOverride] = useState<{
    mode: ServiceMode;
    provider: string;
  } | null>(null);
  const reconciled = useMemo(
    () => (daemonConfig ? reconcileFromDaemonConfig(daemonConfig) : null),
    [daemonConfig],
  );
  // Clear override once daemon config catches up.
  useEffect(() => {
    if (reconciled) setSavedOverride(null);
  }, [reconciled]);
  const savedWebSearchMode = savedOverride?.mode ?? reconciled?.webSearchMode ?? webSearchMode;
  const savedWebSearchProvider = savedOverride?.provider ?? reconciled?.webSearchProvider ?? webSearchProvider;

  // Seed form state from daemon config on first load. Subsequent config
  // refetches (after save) do not overwrite in-progress edits.
  const initialized = useRef(false);
  useEffect(() => {
    if (!daemonConfig || initialized.current) return;
    initialized.current = true;
    const r = reconcileFromDaemonConfig(daemonConfig);
    if (r.webSearchMode) setWebSearchMode(r.webSearchMode);
    if (r.webSearchProvider) setWebSearchProvider(r.webSearchProvider);
  }, [daemonConfig]);

  // --- Secret presence query (TanStack Query) ---
  const isOrgReady = useIsOrgReady();
  const requiresProviderCredential = WEB_SEARCH_BYOK_PROVIDER_IDS.has(webSearchProvider);

  const credentialQueryKey = useMemo(
    () => webSearchCredentialQueryKey(assistantId, webSearchProvider),
    [assistantId, webSearchProvider],
  );

  const credentialQuery = useQuery({
    queryKey: credentialQueryKey,
    queryFn: async () => {
      const { data, error, response } = await secretsReadPost({
        path: { assistant_id: assistantId! },
        body: { type: "api_key", name: webSearchProvider },
        throwOnError: false,
      });
      assertHasResponse(response, error, "Failed to check stored key");
      if (!response.ok) {
        throw new ApiError(
          response.status,
          extractErrorMessage(error, response, `Failed to check stored key (HTTP ${response.status})`),
        );
      }
      return data!.found;
    },
    enabled: !!assistantId && requiresProviderCredential && isOrgReady,
    retry: shouldRetryDaemonError,
    staleTime: 30_000,
  });

  // Defense-in-depth: if retries exhaust on an expected transient error,
  // suppress the Sentry report rather than creating noise.
  useEffect(() => {
    if (!credentialQuery.error) return;
    captureError(credentialQuery.error, {
      context: "settings-ai-web-search-read-credential",
      bestEffort: true,
    });
  }, [credentialQuery.error]);

  const webSearchHasStoredKey = credentialQuery.data ?? false;

  // --- Derived state ---
  const hasNewApiKey = webSearchApiKey.trim().length > 0;
  const effectiveProvider =
    webSearchMode === "managed" ? "inference-provider-native" : webSearchProvider;
  const configChanged =
    webSearchMode !== savedWebSearchMode ||
    effectiveProvider !== savedWebSearchProvider;
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
        services: {
          "web-search": { mode: webSearchMode, provider: providerToSave },
        },
      }).catch((error) => {
        toast.error("Failed to update assistant configuration. Please try again.");
        captureError(error, { context: "patch_daemon_config" });
        throw error;
      });
      // Optimistically mark these values as "saved" so configChanged stays
      // false while the async config refetch is in flight.
      setSavedOverride({ mode: webSearchMode, provider: providerToSave });
    } catch {
      setSaving(false);
      return;
    }
    setSaving(false);
    try {
      setLocalSetting(LS_WEB_SEARCH_MODE, webSearchMode);
      setLocalSetting(LS_WEB_SEARCH_PROVIDER, providerToSave);
      setWebSearchProvider(providerToSave);
      if (hasUserKey) {
        if (storageKey) {
          setLocalSetting(storageKey, trimmed);
        }
        // Optimistic update: mark key as stored immediately, then
        // background-refetch confirms server state.
        queryClient.setQueryData(
          webSearchCredentialQueryKey(assistantId, providerToSave),
          true,
        );
        void queryClient.invalidateQueries({ queryKey: credentialQueryKey });
        setWebSearchApiKey("");
      }
      toast.success("Web search settings saved.");
    } catch (err) {
      captureError(err, { context: "settings-ai-web-search-persist-local" });
      toast.error("Saved, but local preferences could not be written.");
    }
  }, [
    assistantId,
    requiresProviderCredential,
    configMutation,
    provisionProviderKey,
    queryClient,
    credentialQueryKey,
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
    setWebSearchProvider("inference-provider-native");
    setLocalSetting(LS_WEB_SEARCH_PROVIDER, "inference-provider-native");
  }, [webSearchProvider]);

  return (
    <ServiceCard
      title="Web Search"
      subtitle="Configure how your assistant should search the web"
      mode={webSearchMode}
      onModeChange={(m) => setWebSearchMode(m)}
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
              onChange={setWebSearchProvider}
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

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";

import type { ServiceMode } from "@/domains/settings/ai/ai-types";
import { LS_WEB_SEARCH_MODE, LS_WEB_SEARCH_PROVIDER } from "@/domains/settings/ai/ai-types";
import { getWebSearchProviderKeyStorage, reconcileFromDaemonConfig } from "@/domains/settings/ai/ai-utils";
import { ServiceCard, SaveButton, ResetButton } from "@/domains/settings/ai/ai-shared-ui";
import { useDaemonConfig } from "@/domains/settings/ai/use-daemon-config";

export function WebSearchCard() {
  const {
    assistantId,
    config: daemonConfig,
    invalidateConfig,
    provisionProviderKey,
    patchDaemonConfig,
  } = useDaemonConfig();

  const [saving, setSaving] = useState(false);
  const [webSearchMode, setWebSearchMode] = useState<ServiceMode>(
    () => getLocalSetting(LS_WEB_SEARCH_MODE, "your-own") as ServiceMode,
  );
  const [webSearchProvider, setWebSearchProvider] = useState(() =>
    getLocalSetting(LS_WEB_SEARCH_PROVIDER, "inference-provider-native"),
  );
  const [savedWebSearchMode, setSavedWebSearchMode] = useState(webSearchMode);
  const [savedWebSearchProvider, setSavedWebSearchProvider] = useState(webSearchProvider);
  const [webSearchApiKey, setWebSearchApiKey] = useState("");
  const [webSearchHasStoredKey, setWebSearchHasStoredKey] = useState(false);
  const [secretReadRevision, setSecretReadRevision] = useState(0);
  const secretScopeRef = useRef<{
    assistantId: string | null;
    provider: string | null;
  }>({ assistantId: null, provider: null });

  // Hydrate from daemon config on first load
  const initialized = useRef(false);
  useEffect(() => {
    if (!daemonConfig || initialized.current) return;
    initialized.current = true;
    const reconciled = reconcileFromDaemonConfig(daemonConfig);
    if (reconciled.webSearchMode) {
      setWebSearchMode(reconciled.webSearchMode);
      setSavedWebSearchMode(reconciled.webSearchMode);
    }
    if (reconciled.webSearchProvider) {
      setWebSearchProvider(reconciled.webSearchProvider);
      setSavedWebSearchProvider(reconciled.webSearchProvider);
    }
  }, [daemonConfig]);

  // Derived state
  const needsApiKey =
    WEB_SEARCH_BYOK_PROVIDER_IDS.has(webSearchProvider);
  const hasNewApiKey = webSearchApiKey.trim().length > 0;
  const effectiveProvider =
    webSearchMode === "managed" ? "inference-provider-native" : webSearchProvider;
  const configChanged =
    webSearchMode !== savedWebSearchMode ||
    effectiveProvider !== savedWebSearchProvider;
  const needsKeyBeforeSave =
    webSearchMode === "your-own" &&
    needsApiKey &&
    !webSearchHasStoredKey &&
    !hasNewApiKey;
  const saveDisabled =
    saving || needsKeyBeforeSave || (!configChanged && !hasNewApiKey);
  const apiKeyPlaceholder = secretPlaceholder(
    WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS[webSearchProvider] ?? "Enter your API key",
    webSearchHasStoredKey,
  );

  // Check if a stored key exists for the current provider
  useEffect(() => {
    let cancelled = false;
    const previousScope = secretScopeRef.current;
    const currentScope = {
      assistantId: assistantId ?? null,
      provider: webSearchProvider,
    };
    const scopeChanged =
      previousScope.assistantId !== currentScope.assistantId ||
      previousScope.provider !== currentScope.provider;
    secretScopeRef.current = currentScope;

    void (async () => {
      await Promise.resolve();
      if (cancelled) return;

      if (!assistantId || !needsApiKey) {
        setWebSearchHasStoredKey(false);
        return;
      }

      if (scopeChanged) {
        setWebSearchHasStoredKey(false);
      }

      try {
        const { data: result } = await secretsReadPost({
          path: { assistant_id: assistantId },
          body: { type: "api_key", name: webSearchProvider },
          throwOnError: true,
        });
        if (cancelled) return;
        setWebSearchHasStoredKey(result.found);
      } catch (error) {
        if (cancelled) return;
        setWebSearchHasStoredKey(false);
        captureError(error, { context: "settings-ai-web-search-read-secret" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assistantId, needsApiKey, webSearchProvider, secretReadRevision]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const trimmed = webSearchApiKey.trim();
    const providerToSave =
      webSearchMode === "managed" ? "inference-provider-native" : webSearchProvider;
    const storageKey = getWebSearchProviderKeyStorage(providerToSave);
    const hasUserKey =
      webSearchMode === "your-own" && needsApiKey && trimmed.length > 0;
    let remoteSaved = false;
    try {
      if (hasUserKey) {
        await provisionProviderKey(providerToSave, trimmed);
      }
      await patchDaemonConfig({
        services: {
          "web-search": { mode: webSearchMode, provider: providerToSave },
        },
      });
      remoteSaved = true;
      invalidateConfig();
    } catch {
      // Errors already surfaced via toast + captureError inside the callees.
    }
    if (!remoteSaved) {
      setSaving(false);
      return;
    }
    try {
      setLocalSetting(LS_WEB_SEARCH_MODE, webSearchMode);
      setLocalSetting(LS_WEB_SEARCH_PROVIDER, providerToSave);
      setWebSearchProvider(providerToSave);
      setSavedWebSearchMode(webSearchMode);
      setSavedWebSearchProvider(providerToSave);
      if (hasUserKey) {
        if (storageKey) {
          setLocalSetting(storageKey, trimmed);
        }
        setWebSearchHasStoredKey(true);
        setSecretReadRevision((r) => r + 1);
        setWebSearchApiKey("");
      }
      toast.success("Web search settings saved.");
    } catch (err) {
      captureError(err, { context: "settings-ai-web-search-persist-local" });
      toast.error("Saved, but local preferences could not be written.");
    } finally {
      setSaving(false);
    }
  }, [
    invalidateConfig,
    needsApiKey,
    patchDaemonConfig,
    provisionProviderKey,
    webSearchApiKey,
    webSearchMode,
    webSearchProvider,
  ]);

  const handleReset = useCallback(() => {
    const storageKey = getWebSearchProviderKeyStorage(webSearchProvider);
    if (storageKey) {
      removeLocalSetting(storageKey);
    }
    setWebSearchHasStoredKey(false);
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

          {needsApiKey && (
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
            {needsApiKey && (
              <ResetButton onClick={handleReset} filled />
            )}
          </div>
        </div>
      )}
    </ServiceCard>
  );
}

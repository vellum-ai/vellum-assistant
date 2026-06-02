import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";
import { toast } from "@vellum/design-library/components/toast";

import {
  WEB_SEARCH_BYOK_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_DISPLAY_NAMES,
  WEB_SEARCH_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS,
  WEB_SEARCH_PROVIDER_KEY_STORAGE,
} from "@/assistant/generated/web-search-provider-catalog.gen";
import { secretsPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { secretsReadPost } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { getLocalSetting, removeLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
import { assertProvisionSuccess } from "@/domains/settings/ai/ai-utils";

import {
  useDaemonConfig,
  invalidateDaemonConfig,
  daemonConfigPatchMutation,
} from "@/domains/settings/ai/use-daemon-config";
import { ServiceCard, SaveButton, ResetButton } from "@/domains/settings/ai/ai-shared-ui";
import type { ServiceMode } from "@/domains/settings/ai/ai-types";
import { isServiceMode } from "@/domains/settings/ai/ai-types";

// ---------------------------------------------------------------------------
// Local-storage keys
// ---------------------------------------------------------------------------

const LS_WEB_SEARCH_MODE = "vellum:ai:webSearchMode";
const LS_WEB_SEARCH_PROVIDER = "vellum:ai:webSearchProvider";

function getWebSearchProviderKeyStorage(provider: string): string {
  return WEB_SEARCH_PROVIDER_KEY_STORAGE[provider] ?? "";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WebSearchCard() {
  const queryClient = useQueryClient();
  const { assistantId, config } = useDaemonConfig();

  // Derive "saved" state from daemon config (the query data IS the truth)
  const serverMode = config.services?.["web-search"]?.mode;
  const serverProvider = config.services?.["web-search"]?.provider;
  const savedMode: ServiceMode =
    isServiceMode(serverMode) ? serverMode : "your-own";
  const savedProvider: string = serverProvider ?? "inference-provider-native";

  // Draft state (local edits that may differ from server)
  const [mode, setMode] = useState<ServiceMode>(() => {
    const local = getLocalSetting(LS_WEB_SEARCH_MODE, "");
    return isServiceMode(local) ? local : savedMode;
  });
  const [provider, setProvider] = useState(() =>
    getLocalSetting(LS_WEB_SEARCH_PROVIDER, savedProvider),
  );
  const [apiKey, setApiKey] = useState("");
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [secretReadRevision, setSecretReadRevision] = useState(0);
  const secretScopeRef = useRef<{
    assistantId: string | null;
    provider: string | null;
  }>({ assistantId: null, provider: null });
  const [saving, setSaving] = useState(false);

  // Sync draft from server when config first loads
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!config.services && !hydratedRef.current) return;
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (isServiceMode(serverMode)) setMode(serverMode);
    if (serverProvider) setProvider(serverProvider);
  }, [config.services, serverMode, serverProvider]);

  // Mutations
  const patchConfig = useMutation(daemonConfigPatchMutation());
  const provisionSecret = useMutation(secretsPostMutation());

  // Derived
  const requiresCredential = WEB_SEARCH_BYOK_PROVIDER_IDS.has(provider);
  const hasNewCredential = apiKey.trim().length > 0;
  const effectiveProvider =
    mode === "managed" ? "inference-provider-native" : provider;
  const configChanged =
    mode !== savedMode || effectiveProvider !== savedProvider;
  const needsKeyBeforeSave =
    mode === "your-own" && requiresCredential && !hasStoredKey && !hasNewCredential;
  const saveDisabled = saving || needsKeyBeforeSave || (!configChanged && !hasNewCredential);
  const apiKeyPlaceholder = secretPlaceholder(
    WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS[provider] ?? "Enter your API key",
    hasStoredKey,
  );

  // Read stored secret when provider/assistant changes
  useEffect(() => {
    let cancelled = false;
    const previousScope = secretScopeRef.current;
    const currentScope = {
      assistantId: assistantId ?? null,
      provider,
    };
    const scopeChanged =
      previousScope.assistantId !== currentScope.assistantId ||
      previousScope.provider !== currentScope.provider;
    secretScopeRef.current = currentScope;

    void (async () => {
      await Promise.resolve();
      if (cancelled) return;

      if (!assistantId || !requiresCredential) {
        setHasStoredKey(false);
        return;
      }

      if (scopeChanged) {
        setHasStoredKey(false);
      }

      try {
        const { data: result } = await secretsReadPost({
          path: { assistant_id: assistantId },
          body: { type: "api_key", name: provider },
          throwOnError: true,
        });
        if (cancelled) return;
        setHasStoredKey(result.found);
      } catch (error) {
        if (cancelled) return;
        setHasStoredKey(false);
        captureError(error, { context: "settings-ai-web-search-read-secret" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assistantId, requiresCredential, provider, secretReadRevision]);

  // Handlers
  const handleSave = async () => {
    if (!assistantId) {
      toast.error("Assistant not ready. Please try again.");
      return;
    }
    setSaving(true);
    const trimmed = apiKey.trim();
    const providerToSave =
      mode === "managed" ? "inference-provider-native" : provider;
    const storageKey = getWebSearchProviderKeyStorage(providerToSave);
    const hasUserKey =
      mode === "your-own" && requiresCredential && trimmed.length > 0;
    let remoteSaved = false;
    try {
      if (hasUserKey) {
        const result = await provisionSecret.mutateAsync({
          path: { assistant_id: assistantId },
          body: { value: trimmed, type: "api_key", name: providerToSave },
        });
        assertProvisionSuccess(result);
      }
      await patchConfig.mutateAsync({
        path: { assistant_id: assistantId },
        body: {
          services: {
            "web-search": { mode, provider: providerToSave },
          },
        },
      });
      remoteSaved = true;
      invalidateDaemonConfig(queryClient, assistantId);
    } catch (error) {
      captureError(error, { context: "settings-ai-web-search-save" });
      if (!remoteSaved) {
        toast.error("Failed to save web search settings. Please try again.");
      }
    }
    if (!remoteSaved) {
      setSaving(false);
      return;
    }
    try {
      setLocalSetting(LS_WEB_SEARCH_MODE, mode);
      setLocalSetting(LS_WEB_SEARCH_PROVIDER, providerToSave);
      setProvider(providerToSave);
      if (hasUserKey) {
        if (storageKey) {
          setLocalSetting(storageKey, trimmed);
        }
        setHasStoredKey(true);
        setSecretReadRevision((r) => r + 1);
        setApiKey("");
      }
      toast.success("Web search settings saved.");
    } catch (err) {
      captureError(err, { context: "settings-ai-web-search-persist-local" });
      toast.error("Saved, but local preferences could not be written.");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    const storageKey = getWebSearchProviderKeyStorage(provider);
    if (storageKey) {
      removeLocalSetting(storageKey);
    }
    setHasStoredKey(false);
    setApiKey("");
    setProvider("inference-provider-native");
    setLocalSetting(LS_WEB_SEARCH_PROVIDER, "inference-provider-native");
  };

  return (
    <ServiceCard
      title="Web Search"
      subtitle="Configure how your assistant should search the web"
      mode={mode}
      onModeChange={setMode}
    >
      {mode === "managed" ? (
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
              value={provider}
              onChange={setProvider}
              options={WEB_SEARCH_PROVIDER_IDS.map((p) => ({
                value: p,
                label: WEB_SEARCH_PROVIDER_DISPLAY_NAMES[p] ?? p,
              }))}
            />
          </div>

          {requiresCredential && (
            <Input
              label="API Key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={apiKeyPlaceholder}
              fullWidth
            />
          )}

          <div className="flex items-center gap-2">
            <SaveButton onClick={handleSave} disabled={saveDisabled} />
            {saving && <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />}
            {requiresCredential && (
              <ResetButton onClick={handleReset} filled />
            )}
          </div>
        </div>
      )}
    </ServiceCard>
  );
}

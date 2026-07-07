import { useCallback, useEffect, useMemo, useState } from "react";

import { TriangleAlert } from "lucide-react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { configPatch, credentialsSetPost } from "@/generated/daemon/sdk.gen";
import { isNativeDictationSupported } from "@/runtime/native-dictation-partials";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

import {
    ByoServiceCard,
    CredentialsGuide,
    ResetButton,
    SaveButton,
} from "@/domains/settings/ai/shared-ui";
import { LS_STT_API_KEY_PREFIX, LS_STT_PROVIDER } from "@/domains/settings/ai/local-storage-keys";
import { MACOS_NATIVE_STT_PROVIDER_ID, STT_PROVIDERS } from "@/domains/settings/ai/provider-catalogs";

/**
 * How the daemon addresses each card provider: `provider` is the
 * `services.stt.provider` value (the card id and daemon id differ for
 * Whisper), and `credentialService` is the CES namespace for its key.
 * Client-only providers (macOS native dictation) are absent — they never
 * touch the daemon.
 */
const STT_DAEMON_PROVIDER: Record<
  string,
  { provider: string; credentialService: string }
> = {
  deepgram: { provider: "deepgram", credentialService: "deepgram" },
  openai: { provider: "openai-whisper", credentialService: "openai" },
};

export function SpeechToTextCard() {
  const assistantId = useActiveAssistantId();
  // Capability is fixed for the renderer's lifetime, so compute the offered
  // list once: the native provider only exists inside the macOS Electron
  // shell, where the helper's SFSpeechRecognizer bridge is wired.
  const [providers] = useState(() =>
    STT_PROVIDERS.filter(
      (p) => !p.requiresNativeDictation || isNativeDictationSupported(),
    ),
  );
  const defaultProviderId = providers[0]?.id ?? "deepgram";
  const [draftProvider, setDraftProvider] = useState<string>(() => {
    const stored = getLocalSetting(LS_STT_PROVIDER, defaultProviderId);
    // A stored choice this build can't honor (e.g. the native provider
    // outside the Electron shell) falls back to the default instead of
    // rendering an empty dropdown.
    return providers.some((p) => p.id === stored) ? stored : defaultProviderId;
  });
  const [initialProvider, setInitialProvider] = useState<string>(draftProvider);
  const [apiKeyText, setApiKeyText] = useState("");
  const [providerHasKey, setProviderHasKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Self-heal a stored native choice this build can't honor: the visual
  // fallback alone would leave localStorage pointing at a provider the
  // renderer can't use, and since draft and initial both coerce to the
  // fallback, Save stays disabled and could never persist the correction.
  // ONLY the capability-dependent native id is corrected — legacy aliases
  // like "whisper" must survive untouched for normalizeSttProviderId() /
  // migrateLegacyLocalSttSettings() in stt-api.ts to map at transcribe
  // time. Both deps are set-once, so this runs only on mount.
  useEffect(() => {
    const stored = getLocalSetting(LS_STT_PROVIDER, defaultProviderId);
    if (
      stored === MACOS_NATIVE_STT_PROVIDER_ID &&
      !providers.some((p) => p.id === stored)
    ) {
      setLocalSetting(LS_STT_PROVIDER, defaultProviderId);
    }
  }, [providers, defaultProviderId]);

  const selectedProvider = useMemo(() => {
    return providers.find((p) => p.id === draftProvider) ?? providers[0]!;
  }, [providers, draftProvider]);
  const requiresApiKey = selectedProvider.apiKeyPlaceholder !== undefined;

  useEffect(() => {
    const storedKey = getLocalSetting(
      LS_STT_API_KEY_PREFIX + draftProvider,
      "",
    );
    setProviderHasKey(storedKey.length > 0);
    setApiKeyText("");
  }, [draftProvider]);

  const hasChanges = useMemo(() => {
    const providerChanged = draftProvider !== initialProvider;
    const hasNewKey = apiKeyText.trim().length > 0;
    return providerChanged || hasNewKey;
  }, [draftProvider, initialProvider, apiKeyText]);

  const handleSave = useCallback(async () => {
    const trimmedKey = apiKeyText.trim();

    // Local settings back the client-side voice path; keep them in sync.
    setLocalSetting(LS_STT_PROVIDER, draftProvider);
    if (trimmedKey.length > 0) {
      setLocalSetting(LS_STT_API_KEY_PREFIX + draftProvider, trimmedKey);
    }

    // Provision the daemon too: the server-side live-voice session reads the
    // credential store (CES) and `services.stt` config, never localStorage.
    // macOS native dictation is client-only and has no daemon mapping.
    const daemon = STT_DAEMON_PROVIDER[draftProvider];

    setSaving(true);
    try {
      if (daemon) {
        // Push the effective key (freshly typed, else the one already stored
        // locally) so re-saving wires CES even when the masked field is left
        // untouched.
        const effectiveKey =
          trimmedKey.length > 0
            ? trimmedKey
            : getLocalSetting(LS_STT_API_KEY_PREFIX + draftProvider, "");
        if (effectiveKey.length > 0) {
          const { response: keyRes } = await credentialsSetPost({
            path: { assistant_id: assistantId },
            body: {
              service: daemon.credentialService,
              field: "api_key",
              value: effectiveKey,
              label: `${selectedProvider.displayName} API Key`,
            },
            throwOnError: false,
          });
          if (!keyRes?.ok) {
            throw new Error(`Failed to store API key (HTTP ${keyRes?.status ?? "?"})`);
          }
        }
        const { response: cfgRes } = await configPatch({
          path: { assistant_id: assistantId },
          body: { services: { stt: { provider: daemon.provider } } },
          throwOnError: false,
        });
        if (!cfgRes?.ok) {
          throw new Error(`Failed to save configuration (HTTP ${cfgRes?.status ?? "?"})`);
        }
      }

      if (trimmedKey.length > 0) {
        setProviderHasKey(true);
      }
      setInitialProvider(draftProvider);
      setApiKeyText("");
      toast.success("Speech-to-text settings saved");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to save speech-to-text settings",
      );
    } finally {
      setSaving(false);
    }
  }, [assistantId, draftProvider, apiKeyText, selectedProvider]);

  const handleReset = useCallback(() => {
    setLocalSetting(LS_STT_API_KEY_PREFIX + draftProvider, "");
    setProviderHasKey(false);
    setApiKeyText("");
  }, [draftProvider]);

  const apiKeyPlaceholder = providerHasKey
    ? "••••••••  (Enter a new key to replace)"
    : selectedProvider.apiKeyPlaceholder;

  return (
    <ByoServiceCard
      title="Speech-to-Text"
      subtitle={selectedProvider.subtitle}
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Provider
          </label>
          <Dropdown
            value={draftProvider}
            onChange={setDraftProvider}
            options={providers.map((p) => ({
              value: p.id,
              label: p.displayName,
            }))}
            aria-label="STT provider"
          />
        </div>

        {requiresApiKey && (
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              API Key
            </label>
            <Input
              type="password"
              value={apiKeyText}
              onChange={(e) => setApiKeyText(e.target.value)}
              placeholder={apiKeyPlaceholder}
              fullWidth
            />
          </div>
        )}

        {selectedProvider.setupWarning && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3 text-body-small-default text-[var(--content-tertiary)]">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--system-mid-strong)]" />
            <span>{selectedProvider.setupWarning}</span>
          </div>
        )}

        {selectedProvider.credentialsGuide && (
          <CredentialsGuide guide={selectedProvider.credentialsGuide} />
        )}

        <div className="flex items-center justify-end gap-2">
          <SaveButton onClick={handleSave} disabled={!hasChanges || saving} />
          {providerHasKey && <ResetButton onClick={handleReset} />}
        </div>
      </div>
    </ByoServiceCard>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ttsProvidersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { synthesizeTTS } from "@/lib/tts-synthesize";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

import {
    ByoServiceCard,
    CredentialsGuide,
    ResetButton,
    SaveButton,
} from "@/domains/settings/ai/shared-ui";
import { LS_TTS_API_KEY_PREFIX, LS_TTS_PROVIDER, LS_TTS_VOICE_ID_PREFIX } from "@/domains/settings/ai/local-storage-keys";
import { TTS_PROVIDERS } from "@/domains/settings/ai/provider-catalogs";

export function TextToSpeechCard() {
  const assistantId = useActiveAssistantId();
  const assistantName = useAssistantIdentityStore.use.name() ?? "your assistant";
  const isOrgReady = useIsOrgReady();

  const { data: catalogData } = useQuery({
    ...ttsProvidersGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: isOrgReady,
    staleTime: Infinity,
  });
  const providers = catalogData?.providers ?? TTS_PROVIDERS;

  const defaultProviderId = providers[0]?.id ?? "elevenlabs";
  const [draftProvider, setDraftProvider] = useState<string>(() =>
    getLocalSetting(LS_TTS_PROVIDER, defaultProviderId),
  );
  const [initialProvider, setInitialProvider] = useState<string>(draftProvider);
  const [apiKeyText, setApiKeyText] = useState("");
  const [voiceIdText, setVoiceIdText] = useState("");
  const [initialVoiceId, setInitialVoiceId] = useState("");
  const [providerHasKey, setProviderHasKey] = useState(false);
  const [testing, setTesting] = useState(false);

  const selectedProvider = useMemo(() => {
    return providers.find((p) => p.id === draftProvider) ?? providers[0]!;
  }, [draftProvider, providers]);

  const loadProviderState = useCallback((providerId: string) => {
    const storedKey = getLocalSetting(LS_TTS_API_KEY_PREFIX + providerId, "");
    const storedVoiceId = getLocalSetting(
      LS_TTS_VOICE_ID_PREFIX + providerId,
      "",
    );
    setProviderHasKey(storedKey.length > 0);
    setVoiceIdText(storedVoiceId);
    setInitialVoiceId(storedVoiceId);
    setApiKeyText("");
  }, []);

  useEffect(() => {
    loadProviderState(draftProvider);
  }, [draftProvider, loadProviderState]);

  const hasChanges = useMemo(() => {
    const providerChanged = draftProvider !== initialProvider;
    const hasNewKey = apiKeyText.trim().length > 0;
    const voiceIdChanged = voiceIdText.trim() !== initialVoiceId;
    return providerChanged || hasNewKey || voiceIdChanged;
  }, [draftProvider, initialProvider, apiKeyText, voiceIdText, initialVoiceId]);

  const handleSave = useCallback(() => {
    setLocalSetting(LS_TTS_PROVIDER, draftProvider);
    const trimmedKey = apiKeyText.trim();
    if (trimmedKey.length > 0) {
      setLocalSetting(LS_TTS_API_KEY_PREFIX + draftProvider, trimmedKey);
      setProviderHasKey(true);
    }
    const trimmedVoiceId = voiceIdText.trim();
    setLocalSetting(LS_TTS_VOICE_ID_PREFIX + draftProvider, trimmedVoiceId);
    setInitialProvider(draftProvider);
    setInitialVoiceId(trimmedVoiceId);
    setApiKeyText("");
  }, [draftProvider, apiKeyText, voiceIdText]);

  const handleReset = useCallback(() => {
    setLocalSetting(LS_TTS_API_KEY_PREFIX + draftProvider, "");
    setProviderHasKey(false);
    setApiKeyText("");
  }, [draftProvider]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    try {
      const storedApiKey = getLocalSetting(
        LS_TTS_API_KEY_PREFIX + draftProvider,
        "",
      );
      const pendingApiKey = apiKeyText.trim();
      const apiKey = pendingApiKey.length > 0 ? pendingApiKey : storedApiKey;
      if (apiKey.length === 0) {
        toast.error("Save an API key for this provider before testing.");
        return;
      }
      const storedVoiceId = getLocalSetting(
        LS_TTS_VOICE_ID_PREFIX + draftProvider,
        "",
      );
      const pendingVoiceId = voiceIdText.trim();
      const voiceId =
        pendingVoiceId.length > 0 ? pendingVoiceId : storedVoiceId;
      const text = `Hey! It's ${assistantName}. How does this sound?`;
      const result = await synthesizeTTS({
        provider: draftProvider,
        apiKey,
        voiceId,
        text,
      });
      if (result.kind !== "audio") {
        toast.error(result.message);
        return;
      }
      const url = URL.createObjectURL(result.blob);
      try {
        const audio = new Audio(url);
        await audio.play();
        await new Promise<void>((resolve) => {
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    } finally {
      setTesting(false);
    }
  }, [assistantName, apiKeyText, draftProvider, voiceIdText]);

  const apiKeyPlaceholder = providerHasKey
    ? "••••••••  (Enter a new key to replace)"
    : selectedProvider.apiKeyPlaceholder;

  return (
    <ByoServiceCard
      title="Text-to-Speech"
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
            aria-label="TTS provider"
          />
        </div>

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

        {selectedProvider.supportsVoiceSelection && (
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Voice ID
            </label>
            <Input
              type="text"
              value={voiceIdText}
              onChange={(e) => setVoiceIdText(e.target.value)}
              placeholder="Enter a voice ID"
              fullWidth
            />
          </div>
        )}

        <CredentialsGuide guide={selectedProvider.credentialsGuide} />

        <div className="flex items-center gap-2">
          <Button
            variant="outlined"
            onClick={handleTest}
            disabled={testing}
          >
            {testing ? "Testing…" : "Test"}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <SaveButton onClick={handleSave} disabled={!hasChanges} />
            {providerHasKey && <ResetButton onClick={handleReset} />}
          </div>
        </div>
      </div>
    </ByoServiceCard>
  );
}

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";

import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";

import {
  ByoServiceCard,
  CredentialsGuide,
  SaveButton,
  ResetButton,
  type ProviderCredentialsGuide,
} from "@/domains/settings/ai/ai-shared-ui";

// ---------------------------------------------------------------------------
// Provider catalog
// ---------------------------------------------------------------------------

interface STTProvider {
  id: string;
  displayName: string;
  subtitle: string;
  apiKeyPlaceholder: string;
  credentialsGuide: ProviderCredentialsGuide;
}

const STT_PROVIDERS: readonly STTProvider[] = [
  {
    id: "deepgram",
    displayName: "Deepgram",
    subtitle:
      "Fast, accurate speech-to-text transcription. Uses the same API key as Deepgram text-to-speech.",
    apiKeyPlaceholder: "Enter your Deepgram API key",
    credentialsGuide: {
      description:
        "Sign in to Deepgram, navigate to your API Keys page, and create or copy an existing key. This is the same key used for text-to-speech.",
      url: "https://console.deepgram.com/",
      linkLabel: "Open Deepgram Console",
    },
  },
  {
    id: "openai",
    displayName: "OpenAI",
    subtitle: "OpenAI Whisper transcription. Requires an OpenAI API key.",
    apiKeyPlaceholder: "sk-…",
    credentialsGuide: {
      description:
        "Sign in to the OpenAI platform, navigate to API Keys, and create a new secret key.",
      url: "https://platform.openai.com/api-keys",
      linkLabel: "Open OpenAI API Keys",
    },
  },
];

// ---------------------------------------------------------------------------
// Local-storage keys (shared with the Voice settings tab)
// ---------------------------------------------------------------------------

const LS_STT_PROVIDER = "vellum:voice:sttProvider";
const LS_STT_API_KEY_PREFIX = "vellum:voice:sttApiKey:";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SpeechToTextCard() {
  const defaultProviderId = STT_PROVIDERS[0]?.id ?? "deepgram";
  const [draftProvider, setDraftProvider] = useState<string>(() =>
    getLocalSetting(LS_STT_PROVIDER, defaultProviderId),
  );
  const [initialProvider, setInitialProvider] = useState<string>(draftProvider);
  const [apiKeyText, setApiKeyText] = useState("");
  const [providerHasKey, setProviderHasKey] = useState(false);
  const [saving, setSaving] = useState(false);

  const selectedProvider = useMemo<STTProvider>(() => {
    return (
      STT_PROVIDERS.find((p) => p.id === draftProvider) ?? STT_PROVIDERS[0]!
    );
  }, [draftProvider]);

  const loadProviderState = useCallback((providerId: string) => {
    const storedKey = getLocalSetting(LS_STT_API_KEY_PREFIX + providerId, "");
    setProviderHasKey(storedKey.length > 0);
    setApiKeyText("");
  }, []);

  useEffect(() => {
    loadProviderState(draftProvider);
  }, [draftProvider, loadProviderState]);

  const hasChanges = useMemo(() => {
    const providerChanged = draftProvider !== initialProvider;
    const hasNewKey = apiKeyText.trim().length > 0;
    return providerChanged || hasNewKey;
  }, [draftProvider, initialProvider, apiKeyText]);

  const handleSave = useCallback(() => {
    setSaving(true);
    try {
      setLocalSetting(LS_STT_PROVIDER, draftProvider);
      const trimmedKey = apiKeyText.trim();
      if (trimmedKey.length > 0) {
        setLocalSetting(LS_STT_API_KEY_PREFIX + draftProvider, trimmedKey);
        setProviderHasKey(true);
      }
      setInitialProvider(draftProvider);
      setApiKeyText("");
    } finally {
      setSaving(false);
    }
  }, [draftProvider, apiKeyText]);

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
          <label className="block text-body-small-default text-[var(--content-quiet)]">
            Provider
          </label>
          <Dropdown
            value={draftProvider}
            onChange={setDraftProvider}
            options={STT_PROVIDERS.map((p) => ({
              value: p.id,
              label: p.displayName,
            }))}
            aria-label="STT provider"
          />
        </div>

        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-quiet)]">
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

        <CredentialsGuide guide={selectedProvider.credentialsGuide} />

        <div className="flex items-center justify-end gap-2">
          <SaveButton onClick={handleSave} disabled={!hasChanges || saving} />
          {saving && <Loader2 className="h-4 w-4 animate-spin text-stone-400" />}
          {providerHasKey && <ResetButton onClick={handleReset} />}
        </div>
      </div>
    </ByoServiceCard>
  );
}

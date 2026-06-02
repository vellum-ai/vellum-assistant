import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";

import {
  STT_PROVIDERS,
  LS_STT_PROVIDER,
  LS_STT_API_KEY_PREFIX,
} from "@/domains/settings/ai/ai-types";
import {
  ByoServiceCard,
  CredentialsGuide,
  SaveButton,
  ResetButton,
} from "@/domains/settings/ai/ai-shared-ui";

export function SpeechToTextCard() {
  const defaultProviderId = STT_PROVIDERS[0]?.id ?? "deepgram";
  const [draftProvider, setDraftProvider] = useState<string>(() =>
    getLocalSetting(LS_STT_PROVIDER, defaultProviderId),
  );
  const [initialProvider, setInitialProvider] = useState<string>(draftProvider);
  const [apiKeyText, setApiKeyText] = useState("");
  const [providerHasKey, setProviderHasKey] = useState(false);
  const [saving, setSaving] = useState(false);

  const selectedProvider = useMemo(() => {
    return (
      STT_PROVIDERS.find((p) => p.id === draftProvider) ?? STT_PROVIDERS[0]!
    );
  }, [draftProvider]);

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

import { useCallback, useEffect, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  configGetOptions,
  configGetQueryKey,
  ttsProvidersGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { configPatch, credentialsSetPost } from "@/generated/daemon/sdk.gen";
import { useDraftOverride } from "@/domains/settings/ai/use-draft-override";
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
import {
  LS_TTS_API_KEY_PREFIX,
  LS_TTS_PROVIDER,
  LS_TTS_VOICE_ID_PREFIX,
} from "@/domains/settings/ai/local-storage-keys";
import { TTS_PROVIDERS } from "@/domains/settings/ai/provider-catalogs";

/**
 * The daemon config key that the "Voice ID" input maps to, per provider, under
 * `services.tts.providers.<id>`. Providers absent here have no voice selection
 * (`supportsVoiceSelection: false`), so nothing is written for them.
 */
const TTS_VOICE_CONFIG_FIELD: Record<string, "voiceId" | "referenceId"> = {
  elevenlabs: "voiceId",
  "fish-audio": "referenceId",
  xai: "voiceId",
};

export function TextToSpeechCard() {
  const assistantId = useActiveAssistantId();
  const assistantName =
    useAssistantIdentityStore.use.name() ?? "your assistant";
  const isOrgReady = useIsOrgReady();
  const queryClient = useQueryClient();

  const { data: catalogData } = useQuery({
    ...ttsProvidersGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: isOrgReady,
    staleTime: Infinity,
  });
  const providers = catalogData?.providers ?? TTS_PROVIDERS;

  // Seed the provider from the daemon's live config so a Save doesn't clobber a
  // provider configured elsewhere (CLI/other client) when localStorage is stale.
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: 30_000,
  });
  // `services.tts` falls under the ConfigGetResponse index signature (`unknown`),
  // so narrow it explicitly to read the provider and mode.
  const daemonTts = daemonConfig?.services?.tts as
    { provider?: string; mode?: string } | undefined;
  const daemonTtsProvider = daemonTts?.provider;
  const daemonManaged = daemonTts?.mode === "managed";

  const defaultProviderId = providers[0]?.id ?? "elevenlabs";
  const serverProvider = useMemo(
    () =>
      daemonTtsProvider ?? getLocalSetting(LS_TTS_PROVIDER, defaultProviderId),
    [daemonTtsProvider, defaultProviderId],
  );
  const daemonHasProvider = !!daemonTtsProvider;
  const [draftProvider, setDraftProvider] = useDraftOverride(serverProvider);
  const [apiKeyText, setApiKeyText] = useState("");
  const [voiceIdText, setVoiceIdText] = useState("");
  const [initialVoiceId, setInitialVoiceId] = useState("");
  const [providerHasKey, setProviderHasKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

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
    const providerChanged = draftProvider !== serverProvider;
    const hasNewKey = apiKeyText.trim().length > 0;
    const voiceIdChanged = voiceIdText.trim() !== initialVoiceId;
    return providerChanged || hasNewKey || voiceIdChanged;
  }, [draftProvider, serverProvider, apiKeyText, voiceIdText, initialVoiceId]);

  const handleSave = useCallback(async () => {
    const trimmedKey = apiKeyText.trim();
    const trimmedVoiceId = voiceIdText.trim();

    // The provider everything is saved under. Matches draftProvider except
    // when the daemon reports one the dropdown can't represent (e.g. the
    // reserved managed-mode "vellum" id) — then it is the rendered fallback,
    // so the credential, local state, and config PATCH all target the same
    // provider the save activates.
    const activeProvider = selectedProvider.id;

    // Local settings back the client-side voice path; keep them in sync.
    setLocalSetting(LS_TTS_PROVIDER, activeProvider);
    if (trimmedKey.length > 0) {
      setLocalSetting(LS_TTS_API_KEY_PREFIX + activeProvider, trimmedKey);
    }
    setLocalSetting(LS_TTS_VOICE_ID_PREFIX + activeProvider, trimmedVoiceId);

    // Provision the daemon too: the server-side live-voice session reads the
    // credential store (CES) and `services.tts` config, never localStorage.
    // Push the effective key (freshly typed, else the one already stored
    // locally) so re-saving wires CES even when the masked field is untouched.
    const effectiveKey =
      trimmedKey.length > 0
        ? trimmedKey
        : getLocalSetting(LS_TTS_API_KEY_PREFIX + activeProvider, "");
    const voiceField = TTS_VOICE_CONFIG_FIELD[activeProvider];

    setSaving(true);
    try {
      if (effectiveKey.length > 0) {
        const { response: keyRes } = await credentialsSetPost({
          path: { assistant_id: assistantId },
          body: {
            service: activeProvider,
            field: "api_key",
            value: effectiveKey,
            label: `${selectedProvider.displayName} API Key`,
          },
          throwOnError: false,
        });
        if (!keyRes?.ok) {
          throw new Error(
            `Failed to store API key (HTTP ${keyRes?.status ?? "?"})`,
          );
        }
      }
      // Only PATCH the provider when it truly diverges from the persisted
      // value (or the daemon has none yet); otherwise a re-save with just a new
      // key/voice would silently switch a provider set elsewhere. Saving a key
      // from this card is explicit BYOK intent, so a managed-mode daemon is
      // also switched back to your-own — otherwise the key would appear to
      // take effect while the daemon kept using managed speech. Without an
      // effective key (e.g. a voice-ID-only save) the mode stays managed:
      // flipping would trade a working managed setup for a credential-less
      // BYOK provider.
      const escapeManaged = daemonManaged && effectiveKey.length > 0;
      const shouldSetProvider =
        draftProvider !== serverProvider || !daemonHasProvider;
      const ttsBody = {
        ...(shouldSetProvider || escapeManaged
          ? { provider: activeProvider }
          : {}),
        ...(escapeManaged ? { mode: "your-own" } : {}),
        ...(voiceField
          ? {
              providers: { [activeProvider]: { [voiceField]: trimmedVoiceId } },
            }
          : {}),
      };
      if (Object.keys(ttsBody).length > 0) {
        const { response: cfgRes } = await configPatch({
          path: { assistant_id: assistantId },
          body: { services: { tts: ttsBody } },
          throwOnError: false,
        });
        if (!cfgRes?.ok) {
          throw new Error(
            `Failed to save configuration (HTTP ${cfgRes?.status ?? "?"})`,
          );
        }
      }

      setProviderHasKey(effectiveKey.length > 0);
      setInitialVoiceId(trimmedVoiceId);
      setApiKeyText("");
      void queryClient.invalidateQueries({
        queryKey: configGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      toast.success("Text-to-speech settings saved");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to save text-to-speech settings",
      );
    } finally {
      setSaving(false);
    }
  }, [
    assistantId,
    draftProvider,
    apiKeyText,
    voiceIdText,
    selectedProvider,
    serverProvider,
    daemonHasProvider,
    daemonManaged,
    queryClient,
  ]);

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
    <ByoServiceCard title="Text-to-Speech" subtitle={selectedProvider.subtitle}>
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
          <Button variant="outlined" onClick={handleTest} disabled={testing}>
            {testing ? "Testing…" : "Test"}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <SaveButton onClick={handleSave} disabled={!hasChanges || saving} />
            {providerHasKey && <ResetButton onClick={handleReset} />}
          </div>
        </div>
      </div>
    </ByoServiceCard>
  );
}

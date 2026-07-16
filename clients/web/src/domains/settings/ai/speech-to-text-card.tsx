import { useCallback, useEffect, useMemo, useState } from "react";

import { TriangleAlert } from "lucide-react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  configGetOptions,
  configGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { configPatch, credentialsSetPost } from "@/generated/daemon/sdk.gen";
import { useDraftOverride } from "@/domains/settings/ai/use-draft-override";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { isNativeDictationSupported } from "@/runtime/native-dictation-partials";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

import {
  CredentialsGuide,
  ResetButton,
  SaveButton,
  ServiceCard,
} from "@/domains/settings/ai/shared-ui";
import {
  LS_STT_API_KEY_PREFIX,
  LS_STT_MODE,
  LS_STT_PROVIDER,
} from "@/domains/settings/ai/local-storage-keys";
import {
  MACOS_NATIVE_STT_PROVIDER_ID,
  STT_PROVIDERS,
} from "@/domains/settings/ai/provider-catalogs";
import { parseServiceMode } from "@/domains/settings/ai/utils";
import type { ServiceMode } from "@/generated/daemon/types.gen";

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

/**
 * Reverse of `STT_DAEMON_PROVIDER.provider`: maps a `services.stt.provider`
 * daemon id back to the card id used by the dropdown. Only representable
 * daemon providers appear here; ones the static dropdown can't show
 * (e.g. google-gemini/xai) are intentionally absent so we never coerce them.
 */
const CARD_ID_BY_DAEMON_PROVIDER: Record<string, string> = {
  deepgram: "deepgram",
  "openai-whisper": "openai",
};

export function SpeechToTextCard() {
  const assistantId = useActiveAssistantId();
  const isOrgReady = useIsOrgReady();
  const queryClient = useQueryClient();
  // Capability is fixed for the renderer's lifetime, so compute the offered
  // list once: the native provider only exists inside the macOS Electron
  // shell, where the helper's SFSpeechRecognizer bridge is wired.
  const [providers] = useState(() =>
    STT_PROVIDERS.filter(
      (p) => !p.requiresNativeDictation || isNativeDictationSupported(),
    ),
  );
  const defaultProviderId = providers[0]?.id ?? "deepgram";

  // Seed the provider from the daemon's live config so a Save doesn't clobber a
  // provider configured elsewhere (CLI/other client) when localStorage is stale
  // — including daemon providers the static dropdown can't represent.
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: 30_000,
  });
  // `services.stt` falls under the ConfigGetResponse index signature
  // (`unknown`), so narrow it explicitly to read the provider and mode.
  const daemonStt = daemonConfig?.services?.stt as
    { provider?: string; mode?: string } | undefined;
  const daemonSttProvider = daemonStt?.provider;
  // Provider "vellum" routes to managed regardless of mode, so the card must
  // treat it as managed too — otherwise a provider-only managed config (e.g.
  // written via the CLI) would render the Your Own panel, and a save from it
  // could never escape: nothing would look changed, so no provider write.
  const daemonManaged =
    daemonStt?.mode === "managed" || daemonSttProvider === "vellum";

  // Managed vs. your-own toggle. Derived from the daemon (source of truth),
  // falling back to localStorage so the toggle doesn't flash "your-own" before
  // the config query resolves. `useDraftOverride` lets the user flip it locally
  // until a save + refetch converges the server value.
  const serverMode = useMemo<ServiceMode>(
    () =>
      daemonManaged
        ? "managed"
        : parseServiceMode(
            daemonStt?.mode ?? getLocalSetting(LS_STT_MODE, "your-own"),
            "your-own",
          ),
    [daemonManaged, daemonStt?.mode],
  );
  const [mode, setDraftMode] = useDraftOverride(serverMode);

  const serverProvider = useMemo(() => {
    const mapped = daemonSttProvider
      ? CARD_ID_BY_DAEMON_PROVIDER[daemonSttProvider]
      : undefined;
    // Keep the dropdown on a representable value even when the daemon uses one
    // the card can't show, so we never coerce or clobber it.
    if (mapped && providers.some((p) => p.id === mapped)) {
      return mapped;
    }
    const stored = getLocalSetting(LS_STT_PROVIDER, defaultProviderId);
    return providers.some((p) => p.id === stored) ? stored : defaultProviderId;
  }, [daemonSttProvider, providers, defaultProviderId]);
  const daemonHasProvider = !!daemonSttProvider;

  const [draftProvider, setDraftProvider] = useDraftOverride(serverProvider);
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
    const providerChanged = draftProvider !== serverProvider;
    const hasNewKey = apiKeyText.trim().length > 0;
    // Toggling off managed is itself a saveable change: a user with a BYOK
    // provider+key already stored has nothing else to edit.
    const modeChanged = mode !== serverMode;
    return providerChanged || hasNewKey || modeChanged;
  }, [draftProvider, serverProvider, apiKeyText, mode, serverMode]);

  const handleSave = useCallback(async () => {
    const trimmedKey = apiKeyText.trim();

    // Local settings back the client-side voice path; keep them in sync. This
    // handler serves the "Your Own" panel, so the effective mode is your-own.
    setLocalSetting(LS_STT_MODE, "your-own");
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
            throw new Error(
              `Failed to store API key (HTTP ${keyRes?.status ?? "?"})`,
            );
          }
        }
      }

      // The config PATCH runs even for the client-only native choice (which has
      // no daemon mapping): leaving managed must still flip services.stt.mode
      // server-side, or a refetch snaps the card back to Managed. Saving from
      // the "Your Own" panel is explicit BYOK intent, so a managed daemon flips
      // even without a new key — the user reached these inputs by toggling off
      // Managed.
      const escapeManaged = daemonManaged;
      const providerChanged =
        !!daemon && (draftProvider !== serverProvider || !daemonHasProvider);
      // Write `provider` only when the user changed it, or when escaping managed
      // leaves nothing valid to keep (no stored provider, or the "vellum"
      // provider, which routes to managed regardless of mode). Otherwise
      // write mode only and let the daemon's deep-merge preserve the stored
      // provider — which may be one the dropdown can't represent (e.g.
      // google-gemini via CLI) and would be silently overwritten by the fallback.
      const writeProvider =
        providerChanged ||
        (escapeManaged &&
          (!daemonSttProvider || daemonSttProvider === "vellum"));
      if (writeProvider || escapeManaged) {
        const providerValue =
          daemon?.provider ??
          STT_DAEMON_PROVIDER[draftProvider]?.provider ??
          "deepgram";
        const { response: cfgRes } = await configPatch({
          path: { assistant_id: assistantId },
          body: {
            services: {
              stt: {
                ...(writeProvider ? { provider: providerValue } : {}),
                ...(escapeManaged ? { mode: "your-own" } : {}),
              },
            },
          },
          throwOnError: false,
        });
        if (!cfgRes?.ok) {
          throw new Error(
            `Failed to save configuration (HTTP ${cfgRes?.status ?? "?"})`,
          );
        }
      }

      if (trimmedKey.length > 0) {
        setProviderHasKey(true);
      }
      setApiKeyText("");
      void queryClient.invalidateQueries({
        queryKey: configGetQueryKey({ path: { assistant_id: assistantId } }),
      });
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
  }, [
    assistantId,
    draftProvider,
    apiKeyText,
    selectedProvider,
    serverProvider,
    daemonHasProvider,
    daemonManaged,
    daemonSttProvider,
    queryClient,
  ]);

  const handleSaveManaged = useCallback(async () => {
    setSaving(true);
    try {
      // Persist the BYOK provider as the restore value for toggling back. Keep
      // the daemon's existing provider when it has one — it may be a valid
      // provider the dropdown can't represent (e.g. google-gemini set via CLI),
      // which the fallback would silently overwrite. Only synthesize one for a
      // sparse config or the client-only native dictation choice ("deepgram" is
      // the sane default there); the schema requires a provider, and "vellum"
      // would defeat its purpose as a your-own restore value. The daemon routes
      // managed mode to Vellum at runtime regardless of this value.
      const restoreProvider =
        daemonSttProvider && daemonSttProvider !== "vellum"
          ? daemonSttProvider
          : STT_DAEMON_PROVIDER[draftProvider]?.provider ?? "deepgram";
      const { response: cfgRes } = await configPatch({
        path: { assistant_id: assistantId },
        body: { services: { stt: { mode: "managed", provider: restoreProvider } } },
        throwOnError: false,
      });
      if (!cfgRes?.ok) {
        throw new Error(
          `Failed to save configuration (HTTP ${cfgRes?.status ?? "?"})`,
        );
      }
      setLocalSetting(LS_STT_MODE, "managed");
      // The client-only native-dictation choice makes `prefersMacosNativeStt()`
      // keep routing transcription locally, bypassing managed STT on this
      // client. Repoint the stored provider at a daemon-backed one so Managed
      // actually takes effect.
      if (draftProvider === MACOS_NATIVE_STT_PROVIDER_ID) {
        setLocalSetting(LS_STT_PROVIDER, defaultProviderId);
      }
      void queryClient.invalidateQueries({
        queryKey: configGetQueryKey({ path: { assistant_id: assistantId } }),
      });
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
  }, [
    assistantId,
    daemonSttProvider,
    draftProvider,
    defaultProviderId,
    queryClient,
  ]);

  const handleReset = useCallback(() => {
    setLocalSetting(LS_STT_API_KEY_PREFIX + draftProvider, "");
    setProviderHasKey(false);
    setApiKeyText("");
  }, [draftProvider]);

  const apiKeyPlaceholder = providerHasKey
    ? "••••••••  (Enter a new key to replace)"
    : selectedProvider.apiKeyPlaceholder;

  return (
    <ServiceCard
      title="Speech-to-Text"
      subtitle="Configure how your assistant transcribes speech"
      mode={mode}
      onModeChange={(m) => setDraftMode(m)}
    >
      {mode === "managed" ? (
        <div className="space-y-3">
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            Managed transcription is included with your Vellum connection.
          </p>
          <SaveButton onClick={handleSaveManaged} disabled={saving} />
        </div>
      ) : (
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
      )}
    </ServiceCard>
  );
}

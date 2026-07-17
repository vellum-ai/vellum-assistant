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
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { isNativeDictationSupported } from "@/runtime/native-dictation-partials";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

import { PlatformLoginNotice } from "@/components/platform-login-notice";
import {
  ByoServiceCard,
  CredentialsGuide,
  ResetButton,
  SaveButton,
} from "@/domains/settings/ai/shared-ui";
import {
  LS_STT_API_KEY_PREFIX,
  LS_STT_PROVIDER,
} from "@/domains/settings/ai/local-storage-keys";
import {
  MACOS_NATIVE_STT_PROVIDER_ID,
  STT_PROVIDERS,
} from "@/domains/settings/ai/provider-catalogs";

/**
 * How the daemon addresses each card provider: `provider` is the
 * `services.stt.provider` value (the card id and daemon id differ for
 * Whisper), and `credentialService` is the CES namespace for its key.
 * Client-only providers (macOS native dictation) are absent — they never
 * touch the daemon. `vellum` authenticates via the platform connection, so
 * it has no credential service of its own.
 */
const STT_DAEMON_PROVIDER: Record<
  string,
  { provider: string; credentialService?: string }
> = {
  vellum: { provider: "vellum" },
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
  vellum: "vellum",
  deepgram: "deepgram",
  "openai-whisper": "openai",
};

/**
 * Fallback provider, as both a card id and a daemon id. Mirrors the daemon's
 * `services.stt.provider` schema default. Deliberately not `providers[0]` —
 * the dropdown leads with Vellum, and an unconfigured client must not claim
 * the managed provider on its own.
 */
const DEFAULT_PROVIDER_ID = "deepgram";

export function SpeechToTextCard() {
  const assistantId = useActiveAssistantId();
  const isOrgReady = useIsOrgReady();
  const queryClient = useQueryClient();
  const platformGate = usePlatformGate();
  // The native-dictation capability is fixed for the renderer's lifetime, but
  // the platform gate is not (logging in flips "disabled" to "full"), so the
  // offered list is derived per render. "gated" means the platform API is off
  // entirely — logging in cannot help, so the managed option is withheld
  // rather than shown dead.
  const providers = useMemo(
    () =>
      STT_PROVIDERS.filter(
        (p) =>
          (!p.requiresNativeDictation || isNativeDictationSupported()) &&
          (p.id !== "vellum" || platformGate !== "gated"),
      ),
    [platformGate],
  );
  const defaultProviderId = DEFAULT_PROVIDER_ID;

  // Seed the provider from the daemon's live config so a Save doesn't clobber a
  // provider configured elsewhere (CLI/other client) when localStorage is stale
  // — including daemon providers the static dropdown can't represent.
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: 30_000,
  });
  // `services.stt` falls under the ConfigGetResponse index signature
  // (`unknown`), so narrow it explicitly to read the provider.
  const daemonStt = daemonConfig?.services?.stt as
    { provider?: string; mode?: string } | undefined;
  // A config written by the legacy mode toggle marks managed via `mode` while
  // `provider` holds the BYOK restore value — the daemon routes it to Vellum,
  // so the card must render it as Vellum too.
  const daemonSttProvider =
    daemonStt?.mode === "managed" ? "vellum" : daemonStt?.provider;

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
  // time. The provider list recomputes when the platform gate changes, so
  // the effect can re-run — the correction is idempotent, so extra runs
  // are no-ops.
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
    return providerChanged || hasNewKey;
  }, [draftProvider, serverProvider, apiKeyText]);

  // Vellum authenticates via the platform session; without one the save
  // would persist a provider that cannot work, so it is blocked behind the
  // login notice instead.
  const vellumNeedsLogin =
    draftProvider === "vellum" && platformGate === "disabled";

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
      if (daemon?.credentialService) {
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

      // Write `provider` only when the user changed it, or when the daemon has
      // none stored. Otherwise let the deep-merge preserve what is there — it
      // may be a provider the dropdown can't represent (e.g. google-gemini via
      // CLI) that the fallback would silently overwrite.
      //
      // Leaving Vellum for the client-only native choice still has to write:
      // that choice has no daemon mapping, so without it the daemon would stay
      // on Vellum and a refetch would snap the dropdown back.
      const leavingVellum =
        daemonSttProvider === "vellum" && draftProvider !== "vellum";
      const writeProvider =
        (!!daemon && (draftProvider !== serverProvider || !daemonHasProvider)) ||
        leavingVellum;
      if (writeProvider) {
        const providerValue = daemon?.provider ?? DEFAULT_PROVIDER_ID;
        const { response: cfgRes } = await configPatch({
          path: { assistant_id: assistantId },
          body: {
            services: {
              stt: {
                // The provider is always written as a pair with `mode`, which
                // keeps the write valid on every daemon version: older schemas
                // reject provider "vellum" without mode "managed", and a stale
                // `mode: "managed"` from the legacy toggle would win over a
                // BYOK choice unless reset.
                provider: providerValue,
                mode: providerValue === "vellum" ? "managed" : "your-own",
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
    daemonSttProvider,
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
    <ByoServiceCard
      title="Speech-to-Text"
      subtitle="Configure how your assistant transcribes speech"
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

        {draftProvider === "vellum" &&
          (vellumNeedsLogin ? (
            <PlatformLoginNotice>
              Log in to the Vellum platform to use managed transcription.
            </PlatformLoginNotice>
          ) : (
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              Transcription runs through your Vellum account.
            </p>
          ))}

        <div className="flex items-center justify-end gap-2">
          <SaveButton
            onClick={handleSave}
            disabled={!hasChanges || saving || vellumNeedsLogin}
          />
          {providerHasKey && <ResetButton onClick={handleReset} />}
        </div>
      </div>
    </ByoServiceCard>
  );
}

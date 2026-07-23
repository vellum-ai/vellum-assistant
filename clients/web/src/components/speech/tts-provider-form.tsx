import { useCallback, useEffect, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { List, Pencil } from "lucide-react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  configGetOptions,
  configGetQueryKey,
  ttsProvidersGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { configPatch, credentialsSetPost } from "@/generated/daemon/sdk.gen";
import { useDraftOverride } from "@/hooks/use-draft-override";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { synthesizeTTS } from "@/lib/tts-synthesize";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

import {
  CredentialsGuide,
  type ProviderFormSaveHandle,
  ResetButton,
  SaveButton,
} from "@/components/service-form-controls";
import {
  LS_TTS_API_KEY_PREFIX,
  LS_TTS_PROVIDER,
  LS_TTS_VOICE_ID_PREFIX,
} from "@/utils/local-settings-keys";
import { VoicePickerField } from "@/components/speech/voice-picker-field";
import { useManagedVoices } from "@/lib/tts/use-managed-voices";
import { TTS_PROVIDERS } from "@/lib/provider-catalogs";

/**
 * The text-to-speech provider + API key + voice form: provider choice, key
 * entry, managed-voice or BYOK voice-id selection, sample playback, and the
 * writes that activate them — the CES credential write and the `services.tts`
 * config PATCH.
 *
 * Renders bare, with no card or section chrome, so each caller supplies its
 * own: Settings → AI wraps it in a `ByoServiceCard`, the live-voice first-run
 * card renders it as a section of its modal.
 */

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

export interface TtsProviderFormProps {
  /**
   * Assistant to configure. Defaults to the active assistant — pass it
   * explicitly from surfaces bound to a specific chat (the voice first-run
   * card), where the two can diverge.
   */
  assistantId?: string;
  /**
   * Hide the built-in Save. The parent renders its own and drives it through
   * the handle from `onSaveStateChange` — used where several provider forms
   * share one Save.
   */
  hideSaveButton?: boolean;
  /**
   * Hide the "where do I get a key" guide. Set where the surrounding surface
   * already explains the choice and the extra block is noise.
   */
  hideCredentialsGuide?: boolean;
  /** Publishes this form's save state whenever it changes. Must be stable. */
  onSaveStateChange?: (handle: ProviderFormSaveHandle) => void;
}

export function TtsProviderForm({
  assistantId: assistantIdProp,
  hideSaveButton = false,
  hideCredentialsGuide = false,
  onSaveStateChange,
}: TtsProviderFormProps = {}) {
  const activeAssistantId = useActiveAssistantId();
  const assistantId = assistantIdProp ?? activeAssistantId;
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
  const providers = useMemo(() => {
    const fetched = catalogData?.providers;
    if (!fetched) {
      return TTS_PROVIDERS;
    }
    // Assistants running an older catalog omit vellum, but the managed option
    // must still be offered (and a legacy managed config still renders as
    // Vellum) — graft the static entry on.
    if (fetched.some((p) => p.id === "vellum")) {
      return fetched;
    }
    const vellum = TTS_PROVIDERS.find((p) => p.id === "vellum");
    return vellum ? [vellum, ...fetched] : fetched;
  }, [catalogData]);

  // Seed the provider from the daemon's live config so a Save doesn't clobber a
  // provider configured elsewhere (CLI/other client) when localStorage is stale.
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: 30_000,
  });
  // `services.tts` falls under the ConfigGetResponse index signature (`unknown`),
  // so narrow it explicitly to read the provider.
  const daemonTts = daemonConfig?.services?.tts as
    | {
        provider?: string;
        mode?: string;
        providers?: { vellum?: { model?: string } };
      }
    | undefined;
  // A config written by the legacy mode toggle marks managed via `mode` while
  // `provider` holds the BYOK restore value — the daemon routes it to Vellum,
  // so the form must render it as Vellum too.
  const daemonTtsProvider =
    daemonTts?.mode === "managed" ? "vellum" : daemonTts?.provider;

  // Mirrors the daemon's `services.tts.provider` schema default. Deliberately
  // not `providers[0]` — the catalog leads with Vellum, and an unconfigured
  // client must not claim the managed provider on its own.
  const defaultProviderId = "elevenlabs";
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

  // Managed (Vellum) voices, fetched live from the platform via the daemon so
  // the offered list and default track the platform's rate card. Empty until
  // loaded — the picker renders only from platform data.
  const {
    voices: managedVoices,
    defaultModel: defaultManagedVoice,
    fetched,
  } = useManagedVoices(assistantId, { enabled: draftProvider === "vellum" });

  // Managed voice selection. Server value comes from daemon config; absent
  // means the platform default voice.
  const serverManagedVoice =
    daemonTts?.providers?.vellum?.model ?? defaultManagedVoice ?? "";
  const [draftManagedVoice, setDraftManagedVoice] =
    useDraftOverride(serverManagedVoice);
  const selectedManagedVoice =
    managedVoices.find((v) => v.model === draftManagedVoice) ??
    managedVoices[0];

  // Custom-voice entry: a free-text field for a managed voice id outside the
  // curated catalog. Null override means "not yet toggled by the user" — the
  // mode then derives from the saved config, opening custom automatically when
  // the saved voice isn't a catalog voice so an already-custom id shows in the
  // field instead of the picker misrepresenting it as the first catalog voice.
  const [customModeOverride, setCustomModeOverride] = useState<boolean | null>(
    null,
  );
  const serverVoiceInCatalog = managedVoices.some(
    (v) => v.model === serverManagedVoice,
  );
  const customManagedVoice =
    customModeOverride ??
    (fetched && serverManagedVoice !== "" && !serverVoiceInCatalog);

  const selectedProvider = useMemo(() => {
    return providers.find((p) => p.id === draftProvider) ?? providers[0]!;
  }, [draftProvider, providers]);

  // Written to config only when true: never writing on an untouched default
  // keeps "unset = platform default" configs unset, and daemons that predate
  // managed voice selection never receive a field they would silently drop. The
  // non-empty guard keeps a cleared custom-voice field from PATCHing an empty
  // model (which the daemon would treat as an unknown voice).
  const managedVoiceChanged =
    draftProvider === "vellum" &&
    selectedProvider.supportsVoiceSelection &&
    draftManagedVoice.trim() !== "" &&
    draftManagedVoice.trim() !== serverManagedVoice;

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
    return (
      providerChanged || hasNewKey || voiceIdChanged || managedVoiceChanged
    );
  }, [
    draftProvider,
    serverProvider,
    apiKeyText,
    voiceIdText,
    initialVoiceId,
    managedVoiceChanged,
  ]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    const trimmedKey = apiKeyText.trim();
    const trimmedVoiceId = voiceIdText.trim();

    // The provider everything is saved under. Matches draftProvider except
    // when the daemon reports one the dropdown can't represent — then it is
    // the rendered fallback, so the credential, local state, and config PATCH
    // all target the same provider the save activates.
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
      // key/voice would silently switch a provider set elsewhere.
      const shouldSetProvider =
        draftProvider !== serverProvider || !daemonHasProvider;
      const ttsBody = {
        // The provider is always written as a pair with `mode`, which keeps
        // the write valid on every daemon version: older schemas reject
        // provider "vellum" without mode "managed", and a stale
        // `mode: "managed"` from the legacy toggle would win over a BYOK
        // choice unless reset.
        ...(shouldSetProvider
          ? {
              provider: activeProvider,
              mode: activeProvider === "vellum" ? "managed" : "your-own",
            }
          : {}),
        ...(voiceField
          ? {
              providers: { [activeProvider]: { [voiceField]: trimmedVoiceId } },
            }
          : {}),
        ...(managedVoiceChanged
          ? { providers: { vellum: { model: draftManagedVoice.trim() } } }
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
      return true;
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to save text-to-speech settings",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }, [
    assistantId,
    draftProvider,
    draftManagedVoice,
    managedVoiceChanged,
    apiKeyText,
    voiceIdText,
    selectedProvider,
    serverProvider,
    daemonHasProvider,
    queryClient,
  ]);

  // Voices grouped by accent, each row named by its character traits alone —
  // Publish save state so a parent rendering its own Save (see
  // `hideSaveButton`) can enable it and commit this form.
  useEffect(() => {
    onSaveStateChange?.({ hasChanges, saving, save: handleSave });
  }, [onSaveStateChange, hasChanges, saving, handleSave]);

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
  // Vellum authenticates via the platform connection, so it has no key to enter
  // and nothing for the client-side Test path (a direct provider call) to use.
  const isManaged = draftProvider === "vellum";
  // Managed voice selection needs a daemon that persists
  // `services.tts.providers.vellum.model`. Old daemons (and the static
  // fallback catalog used before the live catalog loads) report
  // supportsVoiceSelection: false for vellum, hiding the selector so the UI
  // never claims to save a voice the daemon would ignore.
  const managedVoiceSupported =
    isManaged && selectedProvider.supportsVoiceSelection;

  // The catalog/custom toggle reads as a link at rest — icon plus a standing
  // underline — and sits on the action row beside Save. `inline-flex` overrides
  // the link variant's `inline` display so the icon centers with the label
  // instead of riding the line above it.
  const enterCustomVoiceLink = (
    <Button
      variant="link"
      size="compact"
      className="inline-flex h-auto items-center gap-1 px-0 underline"
      onClick={() => setCustomModeOverride(true)}
    >
      <Pencil className="h-3.5 w-3.5" aria-hidden />
      Enter a custom voice ID
    </Button>
  );
  const chooseFromCatalogLink = (
    <Button
      variant="link"
      size="compact"
      className="inline-flex h-auto items-center gap-1 px-0 underline"
      onClick={() => {
        setCustomModeOverride(false);
        // Snap a non-catalog draft back to a real catalog voice so the picker's
        // trigger label matches the selection.
        if (!managedVoices.some((v) => v.model === draftManagedVoice)) {
          setDraftManagedVoice(
            defaultManagedVoice || managedVoices[0]?.model || "",
          );
        }
      }}
    >
      <List className="h-3.5 w-3.5" aria-hidden />
      Choose from catalog
    </Button>
  );
  // From the catalog the toggle offers custom entry; from custom it offers a way
  // back, but only when there's actually a catalog to return to. Null until the
  // catalog resolves so it never flashes.
  const managedVoiceToggle = !managedVoiceSupported
    ? null
    : customManagedVoice
      ? managedVoices.length > 0
        ? chooseFromCatalogLink
        : null
      : fetched
        ? enterCustomVoiceLink
        : null;

  return (
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

      {!isManaged && (
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

      {managedVoiceSupported && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Voice
          </label>
          {customManagedVoice ? (
            /* Free-text entry for a managed voice id outside the catalog
               (power users, or an id the platform serves but doesn't list). */
            <Input
              type="text"
              value={draftManagedVoice}
              onChange={(e) => setDraftManagedVoice(e.target.value)}
              placeholder="Enter a voice ID"
              aria-label="Custom voice ID"
              fullWidth
            />
          ) : selectedManagedVoice ? (
            /* Collapsed select-style field that opens the shared voice list
               (grouped, per-row preview, provider badge). Controlled so the
               pick stays a draft until Save, matching the rest of this form. */
            <VoicePickerField
              assistantId={assistantId}
              value={draftManagedVoice}
              onChange={setDraftManagedVoice}
            />
          ) : (
            // Gated on `fetched` so the note never flashes while loading.
            fetched && (
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                No managed voices are currently available.
              </p>
            )
          )}
        </div>
      )}

      {selectedProvider.supportsVoiceSelection && !isManaged && (
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

      {/* The credentials guide is the "where's my API key" helper for BYO
          providers. The managed (Vellum) provider needs no key — the assistant
          is already connected — so its "Connect this assistant" card is just
          noise between the voice picker and the preview button. */}
      {!hideCredentialsGuide && !isManaged && (
        <CredentialsGuide guide={selectedProvider.credentialsGuide} />
      )}

      <div className="flex items-center gap-2">
        {!isManaged && (
          <Button variant="outlined" onClick={handleTest} disabled={testing}>
            {testing ? "Testing…" : "Test"}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-3">
          {managedVoiceToggle}
          {!hideSaveButton && (
            <SaveButton onClick={handleSave} disabled={!hasChanges || saving} />
          )}
          {providerHasKey && !isManaged && <ResetButton onClick={handleReset} />}
        </div>
      </div>
    </div>
  );
}

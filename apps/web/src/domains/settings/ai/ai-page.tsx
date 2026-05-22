/* eslint-disable no-restricted-syntax -- LUM-1768: file contains dark: pairs pending semantic-token migration */
import {
  Check,
  Crown,
  ExternalLink,
  Info,
  Loader2,
} from "lucide-react";
import { useNavigate } from "react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";
import { Notice } from "@vellum/design-library/components/notice";
import { SegmentControl } from "@vellum/design-library/components/segment-control";
import { SettingsCard } from "@/domains/settings/components/settings-card.js";
import { Typography } from "@vellum/design-library/components/typography";

import { toast } from "@vellum/design-library/components/toast";
import { client } from "@/generated/api/client.gen.js";
import {
  assistantsDomainsCreateMutation,
  assistantsDomainsDestroyMutation,
  assistantsDomainsListOptions,
  assistantsDomainsListQueryKey,
  assistantsEmailAddressesCreateMutation,
  assistantsEmailAddressesDestroyMutation,
  assistantsEmailAddressesListOptions,
  assistantsEmailAddressesListQueryKey,
  assistantsEmailAddressesStatusRetrieveOptions,
  assistantsEmailAddressesStatusRetrieveQueryKey,
  assistantsListOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import { reportError } from "@/lib/errors/report.js";
import { useEnvironmentStore } from "@/lib/environment/environment-store.js";
import {
  type LlmCatalogModel,
  PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog.js";
import {
  WEB_SEARCH_BYOK_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_DISPLAY_NAMES,
  WEB_SEARCH_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS,
  WEB_SEARCH_PROVIDER_KEY_STORAGE,
} from "@/assistant/generated/web-search-provider-catalog.gen.js";
import { routes } from "@/utils/routes.js";
import { assistantDaemonConfigQueryKey } from "@/lib/sync/query-tags.js";
import { synthesizeTTS } from "@/domains/voice/tts-synthesize.js";
import { getLocalSetting, removeLocalSetting, setLocalSetting } from "@/lib/local-settings.js";
import { CallSiteOverridesModal, type CallSiteOverrideDraft } from "@/domains/settings/ai/call-site-overrides-modal.js";
import { ManageProfilesModal } from "@/domains/settings/ai/manage-profiles-modal.js";
import { ManageProvidersModal } from "@/domains/settings/ai/manage-providers-modal.js";
import { profilePickerLabel, visibleProfilesForPicker } from "@/domains/settings/ai/profile-pickers.js";
import { readSecret } from "@/domains/settings/ai/provider-connections-client.js";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder.js";

// ---------------------------------------------------------------------------
// Constants (mirrored from desktop SettingsStore)
// ---------------------------------------------------------------------------

const AVAILABLE_IMAGE_GEN_MODELS = [
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
] as const;

const IMAGE_GEN_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "gemini-3.1-flash-image-preview": "Nano Banana 2",
  "gemini-3-pro-image-preview": "Nano Banana Pro",
};

/**
 * Providers that have entries in the LLM model catalog and can be used in
 * call-site overrides. Keep this list in sync with MODELS_BY_PROVIDER in
 * llm-model-catalog.ts.
 */
export const INFERENCE_PROVIDERS = [
  "anthropic",
  "openai",
  "fireworks",
  "openrouter",
  "gemini",
] as const;

// Re-export the shared map so existing importers
// (CallSiteOverridesModal, ProfileEditorModal) keep working without an
// extra import in the next refactor pass.
export const INFERENCE_PROVIDER_DISPLAY_NAMES = PROVIDER_DISPLAY_NAMES;

export const TOKEN_SLIDER_MIN_TOKENS = 1_000;
export const TOKEN_SLIDER_STEP_TOKENS = 1_000;
export const DEFAULT_CONTEXT_WINDOW_BUDGET_TOKENS = 200_000;

// Web-search provider list, display names, and key placeholders live in
// `assistant/generated/web-search-provider-catalog.gen.ts`.

// ---------------------------------------------------------------------------
// TTS / STT provider catalogs — mirror the macOS client catalogs and the
// `meta/tts-provider-catalog.json` manifest.
// ---------------------------------------------------------------------------

interface ProviderCredentialsGuide {
  description: string;
  url: string;
  linkLabel: string;
}

interface TTSProvider {
  id: string;
  displayName: string;
  subtitle: string;
  supportsVoiceSelection: boolean;
  apiKeyPlaceholder: string;
  credentialsGuide: ProviderCredentialsGuide;
}

const TTS_PROVIDERS: readonly TTSProvider[] = [
  {
    id: "elevenlabs",
    displayName: "ElevenLabs",
    subtitle:
      "High-quality voice synthesis for conversations and read-aloud. Requires an ElevenLabs API key.",
    supportsVoiceSelection: true,
    apiKeyPlaceholder: "sk_…",
    credentialsGuide: {
      description:
        "Sign in to ElevenLabs, go to your Profile, and copy your API key.",
      url: "https://elevenlabs.io/app/settings/api-keys",
      linkLabel: "Open ElevenLabs API Keys",
    },
  },
  {
    id: "fish-audio",
    displayName: "Fish Audio",
    subtitle:
      "Natural-sounding voice synthesis with custom voice cloning. Requires a Fish Audio API key and voice reference ID.",
    supportsVoiceSelection: true,
    apiKeyPlaceholder: "Enter your Fish Audio API key",
    credentialsGuide: {
      description:
        "Sign in to Fish Audio, navigate to API Keys in your dashboard, and create a new key.",
      url: "https://fish.audio/app/api-keys/",
      linkLabel: "Open Fish Audio API Keys",
    },
  },
  {
    id: "deepgram",
    displayName: "Deepgram",
    subtitle:
      "Fast, accurate text-to-speech synthesis. Uses the same API key as Deepgram speech-to-text.",
    supportsVoiceSelection: false,
    apiKeyPlaceholder: "Enter your Deepgram API key",
    credentialsGuide: {
      description:
        "Sign in to Deepgram, navigate to your API Keys page, and create or copy an existing key. This is the same key used for speech-to-text.",
      url: "https://console.deepgram.com/",
      linkLabel: "Open Deepgram Console",
    },
  },
  {
    id: "xai",
    displayName: "xAI",
    subtitle:
      "Text-to-speech from xAI with expressive voices (eve, ara, rex, sal, leo). Requires an xAI API key.",
    supportsVoiceSelection: false,
    apiKeyPlaceholder: "Enter your xAI API key",
    credentialsGuide: {
      description:
        "Sign in to the xAI console, navigate to API Keys, and create a new key.",
      url: "https://console.x.ai/",
      linkLabel: "Open xAI Console",
    },
  },
];

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

type ServiceMode = "managed" | "your-own";

// ---------------------------------------------------------------------------
// Daemon config types (mirrors the assistant daemon schema)
// ---------------------------------------------------------------------------

export interface ProfileEntry {
  source?: "managed" | "user";
  status?: "active" | "disabled";
  label?: string | null;
  description?: string | null;
  provider?: string | null;
  /**
   * Name of a `provider_connections` row to bind this profile to. When set,
   * the daemon dispatcher resolves auth from this specific connection
   * instead of falling back to "the first active connection for the
   * provider." Mirrors `ProfileEntry.provider_connection` in
   * `assistant/src/config/schemas/llm.ts`. Snake_case wire shape matches
   * the daemon's Zod schema; do not rename without also touching the
   * daemon route handlers.
   */
  provider_connection?: string | null;
  model?: string | null;
  maxTokens?: number;
  effort?: string;
  speed?: string;
  verbosity?: string;
  temperature?: number | null;
  thinking?: { enabled?: boolean; streamThinking?: boolean };
  contextWindow?: { maxInputTokens?: number };
}

interface DaemonConfig {
  services?: {
    "web-search"?: { mode?: string; provider?: string };
    "image-generation"?: { mode?: string };
  };
  llm?: {
    default?: { provider?: string; model?: string };
    activeProfile?: string;
    profileOrder?: string[];
    profiles?: Record<string, ProfileEntry>;
    callSites?: Record<string, CallSiteOverrideDraft | null | undefined>;
  };
}

export interface DaemonConfigReconciliation {
  inferenceProvider?: string;
  selectedModel?: string;
  activeProfile?: string | null;
  profiles?: Record<string, ProfileEntry>;
  profileOrder?: string[];
  webSearchMode?: ServiceMode;
  webSearchProvider?: string;
  imageGenMode?: ServiceMode;
}

export function assertProvisionSuccess(result: unknown): void {
  if ((result as Record<string, unknown>)?.success === false) {
    throw new Error("Failed to provision API key: server returned success=false");
  }
}

export function reconcileFromDaemonConfig(config: DaemonConfig): DaemonConfigReconciliation {
  const services = config.services ?? {};
  const llm = config.llm ?? {};
  const result: DaemonConfigReconciliation = {};

  const provider = llm.default?.provider;
  if (provider) result.inferenceProvider = provider;

  const model = llm.default?.model;
  if (model) result.selectedModel = model;

  if (llm.activeProfile !== undefined) result.activeProfile = llm.activeProfile ?? null;
  if (llm.profiles) result.profiles = llm.profiles;
  if (llm.profileOrder !== undefined) result.profileOrder = llm.profileOrder;

  const wsMode = services["web-search"]?.mode;
  if (wsMode === "managed" || wsMode === "your-own") result.webSearchMode = wsMode;
  const wsProvider = services["web-search"]?.provider;
  if (wsProvider) result.webSearchProvider = wsProvider;

  const igMode = services["image-generation"]?.mode;
  if (igMode === "managed" || igMode === "your-own") result.imageGenMode = igMode;

  return result;
}

// ---------------------------------------------------------------------------
// Local-storage keys
// ---------------------------------------------------------------------------

const LS_IMAGE_GEN_MODE = "vellum_image_gen_mode";
const LS_IMAGE_GEN_MODEL = "vellum_image_gen_model";
const LS_WEB_SEARCH_MODE = "vellum_web_search_mode";
const LS_WEB_SEARCH_PROVIDER = "vellum_web_search_provider";
const LS_EMAIL_MODE = "vellum_email_mode";
const LS_EMAIL_BYO_PROVIDER = "vellum_email_byo_provider";

// TTS / STT localStorage keys (shared with the Voice settings tab)
const LS_TTS_PROVIDER = "voice:ttsProvider";
const LS_TTS_API_KEY_PREFIX = "voice:ttsApiKey:";
const LS_TTS_VOICE_ID_PREFIX = "voice:ttsVoiceId:";
const LS_STT_PROVIDER = "voice:sttProvider";
const LS_STT_API_KEY_PREFIX = "voice:sttApiKey:";

// localStorage key for the image generation credential (matching service-keys page)
const LS_IMAGE_GEN_CREDENTIAL = "vellum_gemini_key";

// Per-web-search-provider localStorage keys live in the generated catalog
// (`WEB_SEARCH_PROVIDER_KEY_STORAGE`). Returns "" for managed providers
// (e.g. `inference-provider-native`) which don't store a user-supplied key.
function getWebSearchProviderKeyStorage(provider: string): string {
  return WEB_SEARCH_PROVIDER_KEY_STORAGE[provider] ?? "";
}

export function clampTokenBudget(
  value: number,
  max: number,
  min = TOKEN_SLIDER_MIN_TOKENS,
): number {
  if (!Number.isFinite(value)) {
    return Math.min(min, max);
  }
  return Math.min(Math.max(Math.round(value), min), max);
}

function formatCompactNumber(value: number, fractionDigits: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  });
}

export function formatCompactTokens(value: number | number[]): string {
  const numericValue = Array.isArray(value) ? (value[0] ?? 0) : value;
  const roundedValue = Math.round(numericValue);
  if (Math.abs(roundedValue) >= 1_000_000) {
    return `${formatCompactNumber(roundedValue / 1_000_000, 2)}M`;
  }
  if (Math.abs(roundedValue) >= 1_000) {
    return `${formatCompactNumber(roundedValue / 1_000, 1)}K`;
  }
  return roundedValue.toLocaleString("en-US");
}

export interface InferenceTokenBudgetState {
  maxOutputTokens: number;
  maxOutputTouched: boolean;
  contextWindowTokens: number;
  contextWindowTouched: boolean;
}

export function resolveTokenBudgetStateForModel(
  model: LlmCatalogModel,
  state: InferenceTokenBudgetState,
): InferenceTokenBudgetState {
  const contextBudget = state.contextWindowTouched
    ? state.contextWindowTokens
    : model.defaultContextWindowTokens;
  const maxOutputBudget = state.maxOutputTouched
    ? state.maxOutputTokens
    : model.maxOutputTokens;

  return {
    maxOutputTokens: clampTokenBudget(
      maxOutputBudget,
      model.maxOutputTokens,
    ),
    maxOutputTouched: state.maxOutputTouched,
    contextWindowTokens: clampTokenBudget(
      contextBudget,
      model.contextWindowTokens,
    ),
    contextWindowTouched: state.contextWindowTouched,
  };
}

export function getLongContextPricingHint(
  model: LlmCatalogModel,
  contextWindowTokens: number,
): string | null {
  const threshold = model.longContextPricingThresholdTokens;
  if (threshold === undefined || contextWindowTokens <= threshold) {
    return null;
  }
  return `Budgets above ${formatCompactTokens(threshold)} may use long-context pricing for ${model.displayName}.`;
}

// ---------------------------------------------------------------------------
// Shared UI atoms
// ---------------------------------------------------------------------------

interface ModeToggleProps {
  mode: ServiceMode;
  onChange: (mode: ServiceMode) => void;
}

function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="max-w-[280px]">
      <SegmentControl<ServiceMode>
        ariaLabel="Service mode"
        value={mode}
        onChange={onChange}
        items={[
          { value: "managed", label: "Managed" },
          { value: "your-own", label: "Your Own" },
        ]}
      />
    </div>
  );
}

interface ServiceCardProps {
  title: string;
  subtitle: string;
  mode: ServiceMode;
  onModeChange: (mode: ServiceMode) => void;
  children: ReactNode;
}

function ServiceCard({ title, subtitle, mode, onModeChange, children }: ServiceCardProps) {
  return (
    <SettingsCard
      title={title}
      subtitle={subtitle}
      accessory={<ModeToggle mode={mode} onChange={onModeChange} />}
    >
      <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
      <div className="mt-4">{children}</div>
    </SettingsCard>
  );
}

interface SaveButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

function SaveButton({ onClick, disabled }: SaveButtonProps) {
  return (
    <Button onClick={onClick} disabled={disabled}>
      Save
    </Button>
  );
}

interface ResetButtonProps {
  onClick: () => void;
  filled?: boolean;
}

function ResetButton({ onClick, filled = false }: ResetButtonProps) {
  return (
    <Button variant={filled ? "danger" : "dangerGhost"} onClick={onClick}>
      Reset
    </Button>
  );
}

interface ByoServiceCardProps {
  title: string;
  subtitle: string;
  children: ReactNode;
}

// ByoServiceCard renders the same visual chrome as ServiceCard for "bring your
// own key" services that don't offer a managed mode (TTS / STT).
function ByoServiceCard({ title, subtitle, children }: ByoServiceCardProps) {
  return (
    <SettingsCard title={title} subtitle={subtitle}>
      <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
      <div className="mt-4">{children}</div>
    </SettingsCard>
  );
}

interface CredentialsGuideProps {
  guide: ProviderCredentialsGuide;
}

function CredentialsGuide({ guide }: CredentialsGuideProps) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-body-small-default text-stone-600 dark:border-moss-600 dark:bg-moss-800 dark:text-stone-300">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-forest-700 dark:text-forest-400" />
      <div className="flex flex-col gap-1">
        <span>{guide.description}</span>
        <a
          href={guide.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-forest-700 underline hover:text-forest-800 dark:text-forest-400"
        >
          {guide.linkLabel}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text-to-Speech card
// ---------------------------------------------------------------------------

function TextToSpeechCard() {
  const defaultProviderId = TTS_PROVIDERS[0]?.id ?? "elevenlabs";
  const [draftProvider, setDraftProvider] = useState<string>(() =>
    getLocalSetting(LS_TTS_PROVIDER, defaultProviderId),
  );
  const [initialProvider, setInitialProvider] = useState<string>(draftProvider);
  const [apiKeyText, setApiKeyText] = useState("");
  const [voiceIdText, setVoiceIdText] = useState("");
  const [initialVoiceId, setInitialVoiceId] = useState("");
  const [providerHasKey, setProviderHasKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const { data: assistantList } = useQuery(assistantsListOptions());
  const assistantName = assistantList?.results?.[0]?.name ?? "your assistant";

  const selectedProvider = useMemo<TTSProvider>(() => {
    return (
      TTS_PROVIDERS.find((p) => p.id === draftProvider) ?? TTS_PROVIDERS[0]!
    );
  }, [draftProvider]);

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
    setSaving(true);
    try {
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
    } finally {
      setSaving(false);
    }
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
          <label className="block text-body-small-default text-[var(--content-quiet)]">
            Provider
          </label>
          <Dropdown
            value={draftProvider}
            onChange={setDraftProvider}
            options={TTS_PROVIDERS.map((p) => ({
              value: p.id,
              label: p.displayName,
            }))}
            aria-label="TTS provider"
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

        {selectedProvider.supportsVoiceSelection && (
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-quiet)]">
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
            <SaveButton onClick={handleSave} disabled={!hasChanges || saving} />
            {saving && (
              <Loader2 className="h-4 w-4 animate-spin text-stone-400" />
            )}
            {providerHasKey && <ResetButton onClick={handleReset} />}
          </div>
        </div>
      </div>
    </ByoServiceCard>
  );
}

// ---------------------------------------------------------------------------
// Speech-to-Text card
// ---------------------------------------------------------------------------

function SpeechToTextCard() {
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

// ---------------------------------------------------------------------------
// Email card
// ---------------------------------------------------------------------------

interface EmailByoProvider {
  id: "mailgun" | "resend";
  displayName: string;
  setupSkill: string;
  docsUrl: string;
}

const EMAIL_BYO_PROVIDERS: readonly EmailByoProvider[] = [
  {
    id: "mailgun",
    displayName: "Mailgun",
    setupSkill: "mailgun-setup",
    docsUrl: "https://www.mailgun.com/",
  },
  {
    id: "resend",
    displayName: "Resend",
    setupSkill: "resend-setup",
    docsUrl: "https://resend.com/",
  },
];

interface EmailServiceCardProps {
  assistantId: string | undefined;
}

function EmailServiceCard({ assistantId }: EmailServiceCardProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const emailRootDomain = useEnvironmentStore.use.emailRootDomain();
  const [mode, setMode] = useState<ServiceMode>(
    () => getLocalSetting(LS_EMAIL_MODE, "managed") as ServiceMode,
  );
  const [byoProviderId, setByoProviderId] = useState<EmailByoProvider["id"]>(
    () =>
      getLocalSetting(
        LS_EMAIL_BYO_PROVIDER,
        "mailgun",
      ) as EmailByoProvider["id"],
  );
  const [subdomainDraft, setSubdomainDraft] = useState("");
  const [usernameDraft, setUsernameDraft] = useState("");
  const [savingMode, setSavingMode] = useState(false);

  // -- Subscription gate (managed mode requires Pro) -------------------------
  // We separate "definitely not Pro" from "unknown" so a failed subscription
  // fetch (transient 5xx, network blip) doesn't lock Pro users out of their
  // own managed email. React Query preserves last-known `data` across failed
  // refetches, so `isExplicitlyNotPro` only flips true when the server told
  // us so. The backend `MANAGED_EMAIL` entitlement remains the source of
  // truth — this gate is just a UX hint to keep Base orgs out of a form that
  // would 403 anyway.
  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled: mode === "managed",
  });
  const subscriptionData = subscriptionQuery.data;
  const isPro = subscriptionData?.plan_id === "pro";
  const isExplicitlyNotPro = !!subscriptionData && !isPro;
  const subscriptionUnknown =
    !subscriptionData &&
    subscriptionQuery.isError &&
    !subscriptionQuery.isFetching;

  // -- Domain & address state (managed mode) ---------------------------------
  const domainsQuery = useQuery({
    ...assistantsDomainsListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId && mode === "managed" && !isExplicitlyNotPro,
  });
  const addressesQuery = useQuery({
    ...assistantsEmailAddressesListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId && mode === "managed" && !isExplicitlyNotPro,
  });

  const domain = domainsQuery.data?.results?.[0];
  const address = addressesQuery.data?.results?.[0];
  const fullDomain = domain ? `${domain.subdomain}.${emailRootDomain}` : null;

  const statusQuery = useQuery({
    ...assistantsEmailAddressesStatusRetrieveOptions({
      path: { assistant_id: assistantId ?? "", id: address?.id ?? "" },
    }),
    enabled: !!assistantId && !!address?.id && mode === "managed",
    refetchOnWindowFocus: false,
  });

  // -- Mutations -------------------------------------------------------------
  const registerDomain = useMutation(assistantsDomainsCreateMutation());
  const deleteDomain = useMutation(assistantsDomainsDestroyMutation());
  const registerAddress = useMutation(assistantsEmailAddressesCreateMutation());
  const deleteAddress = useMutation(assistantsEmailAddressesDestroyMutation());

  const invalidateEmailQueries = useCallback(() => {
    if (!assistantId) return;
    const path = { assistant_id: assistantId };
    void queryClient.invalidateQueries({
      queryKey: assistantsDomainsListQueryKey({ path }),
    });
    void queryClient.invalidateQueries({
      queryKey: assistantsEmailAddressesListQueryKey({ path }),
    });
    if (address?.id) {
      void queryClient.invalidateQueries({
        queryKey: assistantsEmailAddressesStatusRetrieveQueryKey({
          path: { ...path, id: address.id },
        }),
      });
    }
  }, [address?.id, assistantId, queryClient]);

  // -- Handlers --------------------------------------------------------------
  const handleRegisterDomain = useCallback(async () => {
    if (!assistantId) return;
    const trimmed = subdomainDraft.trim().toLowerCase();
    if (!trimmed) {
      toast.error("Enter a subdomain.");
      return;
    }
    try {
      await registerDomain.mutateAsync({
        path: { assistant_id: assistantId },
        body: { subdomain: trimmed },
      });
      setSubdomainDraft("");
      invalidateEmailQueries();
      toast.success(`Domain ${trimmed}.${emailRootDomain} registered.`);
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Failed to register domain.";
      toast.error(message);
    }
  }, [
    assistantId,
    emailRootDomain,
    invalidateEmailQueries,
    registerDomain,
    subdomainDraft,
  ]);

  const handleRegisterAddress = useCallback(async () => {
    if (!assistantId) return;
    const trimmed = usernameDraft.trim().toLowerCase();
    if (!trimmed) {
      toast.error("Enter an email username.");
      return;
    }
    try {
      await registerAddress.mutateAsync({
        path: { assistant_id: assistantId },
        body: { username: trimmed },
      });
      setUsernameDraft("");
      invalidateEmailQueries();
      toast.success("Email address created.");
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Failed to register email address.";
      toast.error(message);
    }
  }, [assistantId, invalidateEmailQueries, registerAddress, usernameDraft]);

  const handleDeleteAddress = useCallback(async () => {
    if (!assistantId || !address?.id) return;
    try {
      await deleteAddress.mutateAsync({
        path: { assistant_id: assistantId, id: address.id },
      });
      invalidateEmailQueries();
      toast.success("Email address removed.");
    } catch {
      toast.error("Failed to remove email address.");
    }
  }, [address?.id, assistantId, deleteAddress, invalidateEmailQueries]);

  const handleDeleteDomain = useCallback(async () => {
    if (!assistantId || !domain?.id) return;
    if (address) {
      toast.error("Remove the email address first.");
      return;
    }
    try {
      await deleteDomain.mutateAsync({
        path: { assistant_id: assistantId, id: domain.id },
      });
      invalidateEmailQueries();
      toast.success("Domain released.");
    } catch {
      toast.error("Failed to release domain.");
    }
  }, [
    address,
    assistantId,
    deleteDomain,
    domain?.id,
    invalidateEmailQueries,
  ]);

  const handleModeChange = useCallback((next: ServiceMode) => {
    setMode(next);
    setLocalSetting(LS_EMAIL_MODE, next);
  }, []);

  const handleSaveMode = useCallback(async () => {
    setSavingMode(true);
    try {
      if (mode === "your-own") {
        setLocalSetting(LS_EMAIL_BYO_PROVIDER, byoProviderId);
      }
      toast.success("Email settings saved.");
    } finally {
      setSavingMode(false);
    }
  }, [byoProviderId, mode]);

  // -- Render ---------------------------------------------------------------
  const selectedByoProvider = useMemo(
    () =>
      EMAIL_BYO_PROVIDERS.find((p) => p.id === byoProviderId) ??
      EMAIL_BYO_PROVIDERS[0]!,
    [byoProviderId],
  );

  return (
    <ServiceCard
      title="Email"
      subtitle="Configure how your assistant sends and receives email"
      mode={mode}
      onModeChange={handleModeChange}
    >
      {mode === "managed" ? (
        <div className="space-y-4">
          {subscriptionUnknown && (
            <Notice
              tone="warning"
              title="Couldn't verify subscription status"
              actions={
                <Button
                  size="compact"
                  variant="outlined"
                  onClick={() => subscriptionQuery.refetch()}
                >
                  Retry
                </Button>
              }
            >
              We couldn&apos;t reach the billing service. The form below
              assumes you&apos;re on Pro — if you&apos;re not, registering a
              domain will fail.
            </Notice>
          )}
          {subscriptionQuery.isLoading ? (
            <div className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking subscription…
            </div>
          ) : isExplicitlyNotPro ? (
            <Notice
              tone="info"
              icon={<Crown className="h-4 w-4" aria-hidden />}
              title="Managed email is a Pro plan feature"
              actions={
                <Button
                  size="compact"
                  onClick={() => navigate(routes.settings.billing)}
                >
                  Upgrade to Pro
                </Button>
              }
            >
              Upgrade to register a {`<your-subdomain>.${emailRootDomain}`}{" "}
              address managed by Vellum, or switch to <strong>Your Own</strong>{" "}
              to bring your own provider.
            </Notice>
          ) : !assistantId ? (
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              No assistant found yet.
            </p>
          ) : !domain ? (
            <div className="space-y-3">
              <label className="block text-body-small-default text-[var(--content-tertiary)]">
                Subdomain
              </label>
              <div className="flex items-center gap-2">
                <Input
                  value={subdomainDraft}
                  onChange={(e) =>
                    setSubdomainDraft(e.target.value.toLowerCase())
                  }
                  placeholder="myassistant"
                  fullWidth
                />
                <span className="shrink-0 text-body-small-default text-[var(--content-tertiary)]">
                  .{emailRootDomain}
                </span>
              </div>
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                Each assistant gets its own subdomain. Lowercase letters,
                numbers, and hyphens only.
              </p>
              <Button
                onClick={handleRegisterDomain}
                disabled={registerDomain.isPending || !subdomainDraft.trim()}
              >
                {registerDomain.isPending ? "Registering…" : "Register"}
              </Button>
            </div>
          ) : !address ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <label className="block text-body-small-default text-[var(--content-tertiary)]">
                    Domain
                  </label>
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--system-positive-weak)] px-2.5 py-0.5 text-body-small-default text-[var(--system-positive-strong)]">
                    <Check className="h-3 w-3" />
                    {fullDomain}
                  </span>
                </div>
                <Button
                  variant="dangerGhost"
                  size="compact"
                  onClick={handleDeleteDomain}
                  disabled={deleteDomain.isPending}
                >
                  Release
                </Button>
              </div>

              <div className="space-y-1">
                <label className="block text-body-small-default text-[var(--content-tertiary)]">
                  Email username
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    value={usernameDraft}
                    onChange={(e) =>
                      setUsernameDraft(e.target.value.toLowerCase())
                    }
                    placeholder="hi"
                    fullWidth
                  />
                  <span className="shrink-0 text-body-small-default text-[var(--content-tertiary)]">
                    @{fullDomain}
                  </span>
                  <Button
                    onClick={handleRegisterAddress}
                    disabled={
                      registerAddress.isPending || !usernameDraft.trim()
                    }
                  >
                    {registerAddress.isPending ? "Creating…" : "Create"}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <label className="block text-body-small-default text-[var(--content-tertiary)]">
                    Address
                  </label>
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--system-positive-weak)] px-2.5 py-0.5 text-body-small-default text-[var(--system-positive-strong)]">
                    <Check className="h-3 w-3" />
                    {address.address}
                  </span>
                </div>
                <Button
                  variant="dangerGhost"
                  size="compact"
                  onClick={handleDeleteAddress}
                  disabled={deleteAddress.isPending}
                >
                  Remove
                </Button>
              </div>

              {statusQuery.data?.usage && (
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  {statusQuery.data.usage.sent_today} /{" "}
                  {statusQuery.data.usage.daily_limit} sent today ·{" "}
                  {statusQuery.data.usage.received_today} received
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Provider
            </label>
            <Dropdown
              value={byoProviderId}
              onChange={(val) =>
                setByoProviderId(val as EmailByoProvider["id"])
              }
              options={EMAIL_BYO_PROVIDERS.map((p) => ({
                value: p.id,
                label: p.displayName,
              }))}
            />
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-body-small-default text-stone-600 dark:border-moss-600 dark:bg-moss-800 dark:text-stone-300">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-forest-700 dark:text-forest-400" />
            <div className="flex flex-col gap-1">
              <span>
                Configure {selectedByoProvider.displayName} via the assistant
                CLI: ask the assistant to run the{" "}
                <code className="rounded bg-[var(--surface-active)] px-1 py-0.5 text-[12px]">
                  {selectedByoProvider.setupSkill}
                </code>{" "}
                skill. It walks you through storing the API key, detecting the
                domain, and (optionally) wiring up an inbound webhook.
              </span>
              <a
                href={selectedByoProvider.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-forest-700 underline hover:text-forest-800 dark:text-forest-400"
              >
                Open {selectedByoProvider.displayName}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <SaveButton onClick={handleSaveMode} disabled={savingMode} />
            {savingMode && (
              <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
            )}
          </div>
        </div>
      )}
    </ServiceCard>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AiPage() {
  const [webSearchSaving, setWebSearchSaving] = useState(false);
  const [imageGenSaving, setImageGenSaving] = useState(false);

  // -- Profile state --
  const [activeProfile, setActiveProfile] = useState<string | null>(null);
  const [savedActiveProfile, setSavedActiveProfile] = useState<string | null>(null);
  const [managedProfileSaving, setManagedProfileSaving] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, ProfileEntry>>({});
  const [profileOrder, setProfileOrder] = useState<string[]>([]);
  const [manageProfilesOpen, setManageProfilesOpen] = useState(false);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [manageProvidersOpen, setManageProvidersOpen] = useState(false);

  // -- Backend provisioning (matches desktop SettingsStore) --
  const queryClient = useQueryClient();
  const { data: assistantList } = useQuery(assistantsListOptions());
  const assistantId = assistantList?.results?.[0]?.id;

  // Fetch daemon config on mount and reconcile state so that settings changed
  // on macOS are reflected here without requiring a manual save first.
  const { data: daemonConfig } = useQuery({
    queryKey: assistantDaemonConfigQueryKey(assistantId),
    queryFn: async () => {
      const { data } = await client.get<DaemonConfig, unknown, true>({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId! },
        throwOnError: true,
      });
      return data as DaemonConfig;
    },
    enabled: !!assistantId,
    staleTime: 30_000,
    // Prevent background refetches from clobbering unsaved user edits.
    refetchOnWindowFocus: false,
  });
  const provisionSecret = useMutation({
    mutationFn: async (vars: { assistantId: string; body: Record<string, unknown> }) => {
      const { data } = await client.post<Record<string, unknown>, unknown, true>({
        url: `/v1/assistants/{assistant_id}/secrets/`,
        path: { assistant_id: vars.assistantId },
        body: vars.body,
        throwOnError: true,
      });
      return data;
    },
  });

  // PATCHes `assistants/{id}/config`, which Django's RuntimeProxyWildcardView
  // forwards to the daemon. Mirrors the desktop `settingsClient.patchConfig`.
  const patchConfigMutation = useMutation({
    mutationFn: async (vars: {
      assistantId: string;
      partial: Record<string, unknown>;
    }) => {
      const { data } = await client.patch<Record<string, unknown>, unknown, true>({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: vars.assistantId },
        body: vars.partial,
        throwOnError: true,
      });
      return data;
    },
  });

  // PUT `assistants/{id}/model/image-gen` — matches desktop
  // `settingsClient.setImageGenModel`.
  const putImageGenModelMutation = useMutation({
    mutationFn: async (vars: { assistantId: string; modelId: string }) => {
      const { data } = await client.put<Record<string, unknown>, unknown, true>({
        url: `/v1/assistants/{assistant_id}/model/image-gen`,
        path: { assistant_id: vars.assistantId },
        body: { modelId: vars.modelId },
        throwOnError: true,
      });
      return data;
    },
  });

  const resolveAssistantId = useCallback(async (): Promise<string | null> => {
    if (assistantId) {
      return assistantId;
    }
    const list = await queryClient.fetchQuery(assistantsListOptions());
    return list.results?.[0]?.id ?? null;
  }, [assistantId, queryClient]);

  const provisionProviderKey = useCallback(
    async (providerName: string, key: string): Promise<void> => {
      try {
        const resolvedId = await resolveAssistantId();
        if (!resolvedId) {
          toast.error("No assistant found. Please hatch an assistant first.");
          throw new Error("No assistant found");
        }
        const provisionResult = await provisionSecret.mutateAsync({
          assistantId: resolvedId,
          body: { value: key, type: "api_key", name: providerName },
        });
        assertProvisionSuccess(provisionResult);
      } catch (error) {
        if (!(error instanceof Error && error.message === "No assistant found")) {
          toast.error(`Failed to save ${providerName} API key. Please try again.`);
        }
        reportError(error, {
          context: "provision_provider_key",
          userMessage: `Failed to provision ${providerName} API key`,
        });
        throw error;
      }
    },
    [provisionSecret, resolveAssistantId],
  );

  const patchDaemonConfig = useCallback(
    async (partial: Record<string, unknown>): Promise<void> => {
      const resolvedId = await resolveAssistantId();
      if (!resolvedId) {
        toast.error("No assistant found. Please hatch an assistant first.");
        throw new Error("No assistant found");
      }
      try {
        await patchConfigMutation.mutateAsync({
          assistantId: resolvedId,
          partial,
        });
      } catch (error) {
        toast.error("Failed to update assistant configuration. Please try again.");
        reportError(error, {
          context: "patch_daemon_config",
          userMessage: "Failed to patch daemon config",
        });
        throw error;
      }
    },
    [patchConfigMutation, resolveAssistantId],
  );

  const setImageGenModelOnDaemon = useCallback(
    async (modelId: string): Promise<void> => {
      const resolvedId = await resolveAssistantId();
      if (!resolvedId) {
        toast.error("No assistant found. Please hatch an assistant first.");
        throw new Error("No assistant found");
      }
      try {
        await putImageGenModelMutation.mutateAsync({
          assistantId: resolvedId,
          modelId,
        });
      } catch (error) {
        toast.error("Failed to update image generation model. Please try again.");
        reportError(error, {
          context: "set_image_gen_model",
          userMessage: `Failed to set image gen model ${modelId}`,
        });
        throw error;
      }
    },
    [putImageGenModelMutation, resolveAssistantId],
  );

  // -- Web Search state --
  const [webSearchMode, setWebSearchMode] = useState<ServiceMode>(
    () => getLocalSetting(LS_WEB_SEARCH_MODE, "your-own") as ServiceMode,
  );
  const [webSearchProvider, setWebSearchProvider] = useState(() =>
    getLocalSetting(LS_WEB_SEARCH_PROVIDER, "inference-provider-native"),
  );
  const [savedWebSearchMode, setSavedWebSearchMode] = useState(webSearchMode);
  const [savedWebSearchProvider, setSavedWebSearchProvider] =
    useState(webSearchProvider);
  const [webSearchApiKey, setWebSearchApiKey] = useState("");
  const [webSearchHasStoredKey, setWebSearchHasStoredKey] = useState(false);
  const [webSearchSecretReadRevision, setWebSearchSecretReadRevision] = useState(0);
  const webSearchSecretScopeRef = useRef<{
    assistantId: string | null;
    provider: string | null;
  }>({ assistantId: null, provider: null });

  // -- Image Generation state --
  const [imageGenMode, setImageGenMode] = useState<ServiceMode>(
    () => getLocalSetting(LS_IMAGE_GEN_MODE, "your-own") as ServiceMode,
  );
  const [imageGenModel, setImageGenModel] = useState(() =>
    getLocalSetting(LS_IMAGE_GEN_MODEL, "gemini-3.1-flash-image-preview"),
  );
  const [imageGenApiKey, setImageGenApiKey] = useState("");

  // -- Derived --
  const webSearchNeedsApiKey =
    WEB_SEARCH_BYOK_PROVIDER_IDS.has(webSearchProvider);
  const webSearchHasNewApiKey = webSearchApiKey.trim().length > 0;
  const webSearchConfigChanged =
    webSearchMode !== savedWebSearchMode ||
    webSearchProvider !== savedWebSearchProvider;
  const webSearchNeedsKeyBeforeSave =
    webSearchMode === "your-own" &&
    webSearchNeedsApiKey &&
    !webSearchHasStoredKey &&
    !webSearchHasNewApiKey;
  const webSearchSaveDisabled =
    webSearchSaving ||
    webSearchNeedsKeyBeforeSave ||
    (!webSearchConfigChanged && !webSearchHasNewApiKey);
  const webSearchApiKeyPlaceholder = secretPlaceholder(
    WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS[webSearchProvider] ?? "Enter your API key",
    webSearchHasStoredKey,
  );
  const orderedProfiles = useMemo(() => {
    const ordered = profileOrder
      .filter((name) => name in profiles)
      .map((name) => ({ name, ...profiles[name]! }));
    // Also surface profiles not in profileOrder (guards against stale/partial config)
    const inOrder = new Set(profileOrder);
    const extras = Object.entries(profiles)
      .filter(([name]) => !inOrder.has(name))
      .map(([name, entry]) => ({ name, ...entry }));
    return [...ordered, ...extras];
  }, [profiles, profileOrder]);

  // Profiles to show in the Default Profile dropdown — hides disabled entries
  // unless the currently-active profile happens to be one of them (so the
  // trigger renders a meaningful label and the user has a visible recovery
  // path). ManageProfilesModal and CallSiteOverridesModal both still consume
  // the full `orderedProfiles` — the latter applies the same "preserve
  // current selection" rule per-row internally.
  const defaultProfilePickerEntries = useMemo(
    () => visibleProfilesForPicker(orderedProfiles, [activeProfile]),
    [orderedProfiles, activeProfile],
  );

  // Guard so background refetches (window focus, reconnect) don't clobber
  // unsaved user edits on the current page visit. Resets on unmount (navigation)
  // so the next page mount always hydrates from the post-save fresh data.
  const daemonConfigInitialized = useRef(false);

  // Hydrate state from the daemon config fetched on mount so that changes made
  // on macOS are reflected without requiring a manual save first.
  useEffect(() => {
    if (!daemonConfig || daemonConfigInitialized.current) return;
    daemonConfigInitialized.current = true;
    const reconciled = reconcileFromDaemonConfig(daemonConfig);
    if (reconciled.activeProfile !== undefined) {
      const resolved = reconciled.activeProfile ?? null;
      setActiveProfile(resolved);
      setSavedActiveProfile(resolved);
    }
    if (reconciled.profiles) setProfiles(reconciled.profiles);
    if (reconciled.profileOrder !== undefined) setProfileOrder(reconciled.profileOrder);
    if (reconciled.webSearchMode) {
      setWebSearchMode(reconciled.webSearchMode);
      setSavedWebSearchMode(reconciled.webSearchMode);
    }
    if (reconciled.webSearchProvider) {
      setWebSearchProvider(reconciled.webSearchProvider);
      setSavedWebSearchProvider(reconciled.webSearchProvider);
    }
    if (reconciled.imageGenMode) setImageGenMode(reconciled.imageGenMode);
  }, [daemonConfig]);

  useEffect(() => {
    let cancelled = false;
    const previousSecretScope = webSearchSecretScopeRef.current;
    const currentSecretScope = {
      assistantId: assistantId ?? null,
      provider: webSearchProvider,
    };
    const secretScopeChanged =
      previousSecretScope.assistantId !== currentSecretScope.assistantId ||
      previousSecretScope.provider !== currentSecretScope.provider;
    webSearchSecretScopeRef.current = currentSecretScope;

    void (async () => {
      await Promise.resolve();
      if (cancelled) return;

      if (!assistantId || !webSearchNeedsApiKey) {
        setWebSearchHasStoredKey(false);
        return;
      }

      if (secretScopeChanged) {
        setWebSearchHasStoredKey(false);
      }

      try {
        const result = await readSecret(assistantId, "api_key", webSearchProvider);
        if (cancelled) return;
        setWebSearchHasStoredKey(result.found);
      } catch (error) {
        if (cancelled) return;
        setWebSearchHasStoredKey(false);
        reportError(error, { context: "settings-ai-web-search-read-secret" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    assistantId,
    webSearchNeedsApiKey,
    webSearchProvider,
    webSearchSecretReadRevision,
  ]);

  // -- Handlers --

  // mainAgent is always written by buildInferenceConfigPatch (not a user-set override)
  const overrideCount = Object.entries(daemonConfig?.llm?.callSites ?? {}).filter(
    ([id, s]) => id !== "mainAgent" && (s?.profile != null || s?.provider != null || s?.model != null),
  ).length;
  const overrideLabel =
    overrideCount === 1 ? "1 Override" : overrideCount > 0 ? `${overrideCount} Overrides` : "Overrides";
  const isProfileDirty = activeProfile !== savedActiveProfile;

  const handleManagedProfileSave = useCallback(async () => {
    if (!assistantId) {
      toast.error("Assistant not ready. Please try again.");
      return;
    }
    setManagedProfileSaving(true);
    try {
      await client.patch({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId },
        body: { llm: { activeProfile: activeProfile } },
        headers: { "Content-Type": "application/json" },
        throwOnError: true,
      });
      setSavedActiveProfile(activeProfile);
      void queryClient.invalidateQueries({ queryKey: assistantDaemonConfigQueryKey(assistantId) });
      toast.success("Profile saved.");
    } catch {
      toast.error("Failed to switch profile. Please try again.");
    } finally {
      setManagedProfileSaving(false);
    }
  }, [activeProfile, assistantId, queryClient]);

  // Applied when ManageProfilesModal reports a change.
  const handleProfilesChanged = useCallback(
    (updates: {
      profiles?: Record<string, ProfileEntry | null>;
      profileOrder?: string[];
      activeProfile?: string | null;
      callSites?: Record<string, string>;
    }) => {
      if (updates.profiles) {
        setProfiles((prev) => {
          const next = { ...prev };
          for (const [name, entry] of Object.entries(updates.profiles!)) {
            if (entry === null) {
              delete next[name];
            } else {
              next[name] = entry;
            }
          }
          return next;
        });
        void queryClient.invalidateQueries({ queryKey: assistantDaemonConfigQueryKey(assistantId) });
      }
      if (updates.profileOrder !== undefined) {
        setProfileOrder(updates.profileOrder);
      }
      if (updates.activeProfile !== undefined) {
        setActiveProfile(updates.activeProfile);
        setSavedActiveProfile(updates.activeProfile);
      }
      if (updates.callSites !== undefined) {
        // Invalidate so callSiteOverrides stays fresh if a subsequent delete
        // fails after a successful call-site reassignment PATCH.
        void queryClient.invalidateQueries({ queryKey: assistantDaemonConfigQueryKey(assistantId) });
      }
    },
    [assistantId, queryClient],
  );

  const handleWebSearchSave = async () => {
    setWebSearchSaving(true);
    const trimmed = webSearchApiKey.trim();
    const storageKey = getWebSearchProviderKeyStorage(webSearchProvider);
    const hasUserKey =
      webSearchMode === "your-own" && webSearchNeedsApiKey && trimmed.length > 0;
    let remoteSaved = false;
    try {
      if (hasUserKey) {
        await provisionProviderKey(webSearchProvider, trimmed);
      }
      // PATCH daemon config: mode + provider for web search.
      // Mirrors desktop `setWebSearchMode` / `setWebSearchProvider` which each
      // PATCH `services["web-search"]`.
      await patchDaemonConfig({
        services: {
          "web-search": { mode: webSearchMode, provider: webSearchProvider },
        },
      });
      remoteSaved = true;
      void queryClient.invalidateQueries({ queryKey: assistantDaemonConfigQueryKey(assistantId) });
    } catch {
      // Errors already surfaced via toast + reportError inside the callees.
    }
    if (!remoteSaved) {
      setWebSearchSaving(false);
      return;
    }
    try {
      // Persist local settings only after remote save succeeds.
      setLocalSetting(LS_WEB_SEARCH_MODE, webSearchMode);
      setLocalSetting(LS_WEB_SEARCH_PROVIDER, webSearchProvider);
      setSavedWebSearchMode(webSearchMode);
      setSavedWebSearchProvider(webSearchProvider);
      if (hasUserKey) {
        if (storageKey) {
          setLocalSetting(storageKey, trimmed);
        }
        setWebSearchHasStoredKey(true);
        setWebSearchSecretReadRevision((revision) => revision + 1);
        setWebSearchApiKey("");
      }
      toast.success("Web search settings saved.");
    } catch (err) {
      reportError(err, {
        context: "settings-ai-web-search-persist-local",
        userMessage: "Saved, but local preferences could not be written.",
      });
    } finally {
      setWebSearchSaving(false);
    }
  };

  const handleWebSearchReset = () => {
    const storageKey = getWebSearchProviderKeyStorage(webSearchProvider);
    if (storageKey) {
      removeLocalSetting(storageKey);
    }
    setWebSearchHasStoredKey(false);
    setWebSearchApiKey("");
    setWebSearchProvider("inference-provider-native");
    setLocalSetting(LS_WEB_SEARCH_PROVIDER, "inference-provider-native");
  };

  const handleImageGenSave = async () => {
    setImageGenSaving(true);
    const trimmed = imageGenApiKey.trim();
    const hasUserKey = imageGenMode === "your-own" && trimmed.length > 0;
    let remoteSaved = false;
    try {
      if (hasUserKey) {
        await provisionProviderKey("gemini", trimmed);
      }
      // PATCH daemon config: mode for image generation, then PUT the model.
      // Matches desktop `setImageGenMode` (patchConfig) + `setImageGenModel`
      // (PUT `assistants/{id}/model/image-gen`).
      await patchDaemonConfig({
        services: { "image-generation": { mode: imageGenMode } },
      });
      await setImageGenModelOnDaemon(imageGenModel);
      remoteSaved = true;
      void queryClient.invalidateQueries({ queryKey: assistantDaemonConfigQueryKey(assistantId) });
    } catch {
      // Errors already surfaced via toast + reportError inside the callees.
    }
    if (!remoteSaved) {
      setImageGenSaving(false);
      return;
    }
    try {
      // Persist local settings only after remote save succeeds.
      setLocalSetting(LS_IMAGE_GEN_MODE, imageGenMode);
      setLocalSetting(LS_IMAGE_GEN_MODEL, imageGenModel);
      if (hasUserKey) {
        setLocalSetting(LS_IMAGE_GEN_CREDENTIAL, trimmed);
        setImageGenApiKey("");
      }
      toast.success("Image generation settings saved.");
    } catch (err) {
      reportError(err, {
        context: "settings-ai-image-gen-persist-local",
        userMessage: "Saved, but local preferences could not be written.",
      });
    } finally {
      setImageGenSaving(false);
    }
  };

  const handleImageGenReset = () => {
    removeLocalSetting(LS_IMAGE_GEN_CREDENTIAL);
    setImageGenApiKey("");
    setImageGenModel("gemini-3.1-flash-image-preview");
    setLocalSetting(LS_IMAGE_GEN_MODEL, "gemini-3.1-flash-image-preview");
  };

  return (
    <div className="max-w-[940px] space-y-5">
      {/* Managed services billing banner. The link is inline with the
          sentence (rather than its own flex column) so it wraps with
          the surrounding prose on narrow viewports — at mobile width
          the prior layout pushed "View pricing" into a 2-line column
          alongside 3 lines of body text, which read as two competing
          blocks. `items-start` plus a small mt-0.5 on the Info icon
          keep the icon aligned with the first line of wrapping text. */}
      <div className="flex items-start gap-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] px-4 py-2.5 dark:border-[var(--border-base)] dark:bg-[var(--surface-lift)]">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />
        <p className="text-body-medium-lighter text-[var(--content-secondary)]">
          Managed services are metered and deducted from your Vellum account
          balance.{" "}
          <a
            href="https://www.vellum.ai/docs/pricing"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[var(--primary-base)] hover:underline"
          >
            View pricing
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </p>
      </div>

      {/* Language Model */}
      <ByoServiceCard
        title="Language Model"
        subtitle="Configure the LLMs that power your assistant"
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Default Profile
            </label>
            <Dropdown
              value={activeProfile ?? ""}
              onChange={(val) => {
                setActiveProfile(val === "" ? null : val);
              }}
              placeholder="Select a default profile…"
              options={defaultProfilePickerEntries.map((p) => ({
                value: p.name,
                label: profilePickerLabel(p),
              }))}
            />
            {defaultProfilePickerEntries.length === 0 ? (
              <Typography
                variant="body-small-default"
                as="p"
                className="mt-1 text-(--content-tertiary)"
              >
                No profiles yet. Click Profiles below to create one.
              </Typography>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outlined"
              size="compact"
              onClick={() => setManageProvidersOpen(true)}
            >
              Providers
            </Button>
            <Button
              variant="outlined"
              size="compact"
              onClick={() => setManageProfilesOpen(true)}
            >
              Profiles
            </Button>
            <Button
              variant="outlined"
              size="compact"
              onClick={() => setOverridesOpen(true)}
            >
              {overrideLabel}
            </Button>
          </div>

          {isProfileDirty && (
            <div className="flex items-center gap-2">
              <SaveButton onClick={handleManagedProfileSave} disabled={managedProfileSaving} />
              {managedProfileSaving && (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
              )}
            </div>
          )}
        </div>
      </ByoServiceCard>

      {/* Web Search */}
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
              <SaveButton onClick={handleWebSearchSave} disabled={webSearchSaveDisabled} />
              {webSearchSaving && <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />}
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

            {webSearchNeedsApiKey && (
              <Input
                label="API Key"
                type="password"
                value={webSearchApiKey}
                onChange={(e) => setWebSearchApiKey(e.target.value)}
                placeholder={webSearchApiKeyPlaceholder}
                fullWidth
              />
            )}

            <div className="flex items-center gap-2">
              <SaveButton onClick={handleWebSearchSave} disabled={webSearchSaveDisabled} />
              {webSearchSaving && <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />}
              {webSearchNeedsApiKey && (
                <ResetButton onClick={handleWebSearchReset} filled />
              )}
            </div>
          </div>
        )}
      </ServiceCard>

      {/* Email */}
      <EmailServiceCard assistantId={assistantId} />

      {/* Image Generation */}
      <ServiceCard
        title="Image Generation"
        subtitle="Configure which model your assistant uses to generate images"
        mode={imageGenMode}
        onModeChange={(m) => setImageGenMode(m)}
      >
        {imageGenMode === "managed" ? (
          <div className="space-y-3">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Active Model
            </label>
            <div className="flex items-end gap-3">
              <Dropdown
                className="flex-1"
                value={imageGenModel}
                onChange={setImageGenModel}
                options={AVAILABLE_IMAGE_GEN_MODELS.map((model) => ({
                  value: model,
                  label: IMAGE_GEN_MODEL_DISPLAY_NAMES[model] ?? model,
                }))}
              />
              <SaveButton
                onClick={handleImageGenSave}
                disabled={imageGenSaving}
              />
              {imageGenSaving && (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Input
              label="API Key"
              type="password"
              value={imageGenApiKey}
              onChange={(e) => setImageGenApiKey(e.target.value)}
              placeholder="Enter your Gemini API key"
              fullWidth
            />

            <div className="space-y-1">
              <label className="block text-body-small-default text-[var(--content-tertiary)]">
                Active Model
              </label>
              <Dropdown
                value={imageGenModel}
                onChange={setImageGenModel}
                options={AVAILABLE_IMAGE_GEN_MODELS.map((model) => ({
                  value: model,
                  label: IMAGE_GEN_MODEL_DISPLAY_NAMES[model] ?? model,
                }))}
              />
            </div>

            <div className="flex items-center gap-2">
              <SaveButton onClick={handleImageGenSave} disabled={imageGenSaving} />
              {imageGenSaving && <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />}
              <ResetButton onClick={handleImageGenReset} />
            </div>
          </div>
        )}
      </ServiceCard>

      <TextToSpeechCard />

      <SpeechToTextCard />

      {assistantId && (
        <ManageProfilesModal
          isOpen={manageProfilesOpen}
          profiles={profiles}
          profileOrder={profileOrder}
          activeProfile={activeProfile}
          assistantId={assistantId}
          callSiteOverrides={daemonConfig?.llm?.callSites ?? {}}
          onClose={() => setManageProfilesOpen(false)}
          onProfilesChanged={handleProfilesChanged}
        />
      )}

      {assistantId && (
        <CallSiteOverridesModal
          isOpen={overridesOpen}
          onClose={() => setOverridesOpen(false)}
          assistantId={assistantId}
          orderedProfiles={orderedProfiles}
          persistedOverrides={daemonConfig?.llm?.callSites ?? {}}
          daemonConfigLoaded={!!daemonConfig}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: assistantDaemonConfigQueryKey(assistantId) });
          }}
        />
      )}

      {assistantId && (
        <ManageProvidersModal
          isOpen={manageProvidersOpen}
          assistantId={assistantId}
          onClose={() => setManageProvidersOpen(false)}
        />
      )}
    </div>
  );
}

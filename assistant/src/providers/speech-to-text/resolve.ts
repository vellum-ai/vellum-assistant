import { getConfig } from "../../config/loader.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { createDaemonBatchTranscriber } from "../../stt/daemon-batch-transcriber.js";
import { sttCatalogKeyForRole, type SttRole } from "../../stt/roles.js";
import type {
  BatchTranscriber,
  StreamingTranscriber,
  SttProviderId,
} from "../../stt/types.js";
import { SttError } from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";
import {
  batchBoundaryGapReason,
  getCredentialProvider,
  getProviderEntry,
  isManagedSttProvider,
  resolveSttCatalogKey,
  supportsBoundary,
  supportsDiarization,
} from "./provider-catalog.js";

const log = getLogger("stt-resolver");

// ---------------------------------------------------------------------------
// Default spoken language
// ---------------------------------------------------------------------------

/**
 * Providers that decode language-less audio as English rather than detecting
 * the spoken language: Deepgram directly, and the managed relay, which dials
 * Deepgram server-side. For these, an unset `services.stt.language` is not a
 * neutral state: it is a silent English pin that returns non-English speech
 * as English-sounding nonsense.
 *
 * Providers absent from this set need no default: xAI, Gemini and Whisper all
 * detect natively from the audio when no language is sent.
 */
const MULTILINGUAL_DEFAULT_PROVIDERS: ReadonlySet<SttProviderId> = new Set([
  "deepgram",
  "vellum",
  // Managed Flux resolves an absent language to `flux-general-en` relay-side,
  // so unset is an English pin here too. With "multi" the relay selects
  // `flux-general-multi` and lets Flux detect and code-switch.
  "vellum-flux",
] as SttProviderId[]);

/**
 * The language an unset config resolves to on the providers above: nova-3's
 * code-switching mode, which follows a speaker between the ten languages of
 * Deepgram's multi roster (`DEEPGRAM_MULTI_LANGUAGE_CODES` in `deepgram.ts`)
 * without being told which one they are speaking. Chosen over an English pin
 * because the failure it replaces is
 * silent: a Hindi speaker under the English default gets fluent-looking
 * garbage rather than an error, and has no way to tell recognition is
 * misconfigured from the transcript alone.
 *
 * It is a default, not a ceiling. Speakers of the other 39 languages on the
 * monolingual roster still pick theirs explicitly, and that pick continues to
 * win here. This only decides what happens when nobody has chosen.
 */
const DEFAULT_MULTILINGUAL_CODE = "multi";

/**
 * The spoken language to transcribe with, given what config holds and which
 * provider will receive it. Configured values always win; the default only
 * fills the unset case, and only where unset would otherwise mean English.
 *
 * Applied inside the resolvers rather than at the config layer so config keeps
 * recording what the user chose (or that they chose nothing). The settings
 * surfaces read that distinction to show which rows are defaults, and the live
 * session compares raw config values to decide whether a language change needs
 * a re-dial.
 */
export function effectiveSttLanguage(
  providerId: SttProviderId,
  configured: string | undefined,
): string | undefined {
  if (configured) {
    return configured;
  }
  return MULTILINGUAL_DEFAULT_PROVIDERS.has(providerId)
    ? DEFAULT_MULTILINGUAL_CODE
    : undefined;
}

/**
 * Record which provider a role actually dialed, when that differs from the
 * global setting.
 *
 * `assistant config get` reports what was set, not what resolved, and managed
 * defaulting already substitutes silently. A role override adds a second way
 * for the two to diverge, so the divergence is logged rather than left to be
 * inferred from a provider's behaviour.
 */
function logRoleSelection(
  role: SttRole | undefined,
  resolved: SttProviderId,
  base: SttProviderId,
): void {
  if (role === undefined || resolved === base) {
    return;
  }
  log.info(
    { role, providerId: resolved, baseProviderId: base },
    "STT role override selected a provider other than services.stt.provider",
  );
}

// ---------------------------------------------------------------------------
// Batch transcriber resolver (existing public API — unchanged contract)
// ---------------------------------------------------------------------------

/**
 * Resolve a `BatchTranscriber` for daemon-hosted batch transcription.
 *
 * Reads `services.stt.provider` from the assistant config to determine which
 * STT provider to use, then looks up the corresponding credential via the
 * provider catalog. Credential lookup is centralized here (an authorized
 * secure-keys importer) so callers don't need to import secure-keys directly.
 *
 * Returns `null` when:
 * - The configured provider is not in the catalog.
 * - No credentials are configured for the resolved provider.
 *
 * Throws an {@link SttError} when the configured provider is in the catalog
 * but has no `daemon-batch` boundary. That is a configuration mismatch the
 * resolver can name, and returning `null` for it would reach the user as the
 * "no speech-to-text provider is configured" copy every caller pairs with
 * `null`, which is the opposite of what happened.
 */
export async function resolveBatchTranscriber(
  options: { role?: SttRole } = {},
): Promise<BatchTranscriber | null> {
  // Snapshot the stt config once, before any await, so a concurrent config
  // change cannot pair one setting's old value with another's new value.
  const stt = getConfig().services.stt;
  const provider = sttCatalogKeyForRole(stt, options.role);
  logRoleSelection(options.role, provider, resolveSttCatalogKey(stt));
  const language = effectiveSttLanguage(
    provider as SttProviderId,
    stt.language,
  );

  // Look up credential provider via the catalog.
  const credentialProviderName = getCredentialProvider(
    provider as SttProviderId,
  );
  if (!credentialProviderName) {
    return null;
  }

  // Verify the provider supports the daemon-batch boundary.
  if (!supportsBoundary(provider as SttProviderId, "daemon-batch")) {
    const reason = batchBoundaryGapReason(provider as SttProviderId);
    log.warn({ providerId: provider }, reason);
    throw new SttError("provider-error", reason, { userFacing: true });
  }

  if (provider === "vellum") {
    // Managed batch rides the platform's speech proxy, which forwards the
    // language to Deepgram server-side. A platform build predating that
    // field ignores it rather than failing, so the daemon can send one
    // before the platform side deploys.
    return (await sttProviderKeyResolves("vellum"))
      ? createDaemonBatchTranscriber(null, "vellum", language)
      : null;
  }

  const apiKey = await getProviderKeyAsync(credentialProviderName);
  return createDaemonBatchTranscriber(
    apiKey,
    provider as SttProviderId,
    language,
  );
}

// ---------------------------------------------------------------------------
// Telephony capability resolver
// ---------------------------------------------------------------------------

/**
 * Result of resolving whether the configured `services.stt` provider is
 * eligible for telephony call ingestion.
 */
export type TelephonySttCapability =
  | {
      /** The configured provider supports telephony. */
      status: "supported";
      providerId: SttProviderId;
      /** How the provider participates in real-time call ingestion. */
      telephonyMode: "realtime-ws" | "batch-only";
    }
  | {
      /** The configured provider does not support telephony. */
      status: "unsupported";
      providerId: SttProviderId;
      reason: string;
    }
  | {
      /** The configured provider is unknown or not in the catalog. */
      status: "unconfigured";
      reason: string;
    }
  | {
      /** The provider is eligible but missing credentials. */
      status: "missing-credentials";
      providerId: SttProviderId;
      credentialProvider: string;
      reason: string;
    };

/**
 * Validate whether the STT provider serving telephony is eligible for
 * real-time call ingestion.
 *
 * This resolver does **not** create a live transcriber: it only validates
 * that the configuration, catalog entry, and credentials are all in order.
 *
 * The provider is the telephony role's, which is the one a call actually
 * dials. Reading the global provider instead would answer about a provider
 * no call uses: a credentialed role selection would be turned away for the
 * global's missing key, and the inverse would pass preflight and fail at the
 * dial.
 *
 * Callers can branch on the discriminated `status` field:
 * - `"supported"`: the provider is telephony-eligible and credentials exist.
 * - `"unsupported"`: the provider exists but has `telephonyMode: "none"`.
 * - `"unconfigured"`: the provider is unknown or missing from the catalog.
 * - `"missing-credentials"`: the provider is eligible but has no API key.
 */
export async function resolveTelephonySttCapability(): Promise<TelephonySttCapability> {
  const config = getConfig();
  const provider = sttCatalogKeyForRole(config.services.stt, "telephony");

  const entry = getProviderEntry(provider as SttProviderId);
  if (!entry) {
    return {
      status: "unconfigured",
      reason: `STT provider "${provider}" is not in the provider catalog`,
    };
  }

  if (entry.telephonyMode === "none") {
    return {
      status: "unsupported",
      providerId: entry.id,
      reason: `STT provider "${entry.id}" does not support telephony`,
    };
  }

  // Provider is telephony-eligible — verify credentials exist.
  if (!(await sttProviderKeyResolves(entry.credentialProvider))) {
    return {
      status: "missing-credentials",
      providerId: entry.id,
      credentialProvider: entry.credentialProvider,
      reason: sttCredentialGapReason(entry.credentialProvider),
    };
  }

  return {
    status: "supported",
    providerId: entry.id,
    telephonyMode: entry.telephonyMode,
  };
}

// ---------------------------------------------------------------------------
// Conversation streaming capability resolver
// ---------------------------------------------------------------------------

/**
 * Result of resolving whether the configured `services.stt` provider
 * supports conversation streaming for chat message capture.
 */
export type ConversationStreamingSttCapability =
  | {
      /** The configured provider supports conversation streaming. */
      status: "supported";
      providerId: SttProviderId;
      /** How the provider implements conversation streaming. */
      streamingMode: "realtime-ws" | "incremental-batch";
    }
  | {
      /** The configured provider does not support conversation streaming. */
      status: "unsupported";
      providerId: SttProviderId;
      reason: string;
    }
  | {
      /** The configured provider is unknown or not in the catalog. */
      status: "unconfigured";
      reason: string;
    }
  | {
      /** The provider is eligible but missing credentials. */
      status: "missing-credentials";
      providerId: SttProviderId;
      credentialProvider: string;
      reason: string;
    };

/**
 * Validate whether the configured `services.stt` provider supports
 * conversation streaming for chat message capture (chat composer and
 * iOS input bar).
 *
 * This resolver does **not** create a live streaming session — it only
 * validates that the configuration, catalog entry, and credentials are
 * all in order. The actual session creation is handled by the runtime
 * session orchestrator (PR 5).
 *
 * Callers can branch on the discriminated `status` field:
 * - `"supported"` — the provider supports streaming and credentials exist.
 * - `"unsupported"` — the provider exists but has
 *   `conversationStreamingMode: "none"`.
 * - `"unconfigured"` — the provider is unknown or missing from the catalog.
 * - `"missing-credentials"` — the provider is eligible but has no API key.
 */
export async function resolveConversationStreamingSttCapability(): Promise<ConversationStreamingSttCapability> {
  const config = getConfig();
  const provider = resolveSttCatalogKey(config.services.stt);

  const entry = getProviderEntry(provider as SttProviderId);
  if (!entry) {
    return {
      status: "unconfigured",
      reason: `STT provider "${provider}" is not in the provider catalog`,
    };
  }

  if (entry.conversationStreamingMode === "none") {
    return {
      status: "unsupported",
      providerId: entry.id,
      reason: `STT provider "${entry.id}" does not support conversation streaming`,
    };
  }

  // Provider is streaming-eligible — verify credentials exist.
  if (!(await sttProviderKeyResolves(entry.credentialProvider))) {
    return {
      status: "missing-credentials",
      providerId: entry.id,
      credentialProvider: entry.credentialProvider,
      reason: sttCredentialGapReason(entry.credentialProvider),
    };
  }

  return {
    status: "supported",
    providerId: entry.id,
    streamingMode: entry.conversationStreamingMode,
  };
}

// ---------------------------------------------------------------------------
// Streaming transcriber resolver
// ---------------------------------------------------------------------------

/**
 * Speaker diarization preference for a streaming session.
 *
 * - `"off"` (default): never request diarization. Behavior unchanged from
 *   pre-diarization callers.
 * - `"preferred"`: enable diarization when the configured provider supports
 *   it; silently proceed without it on non-capable providers.
 * - `"required"`: enable diarization on capable providers; return `null` and
 *   log a warning on non-capable providers. Callers that pass `"required"`
 *   are expected to surface a clear error to the user.
 */
export type DiarizePreference = "preferred" | "required" | "off";

/**
 * Options for resolving a streaming transcriber.
 */
export interface ResolveStreamingTranscriberOptions {
  /** Audio sample rate in Hz from the client WebSocket connection. */
  sampleRate?: number;
  /**
   * Provider to resolve a transcriber for. Defaults to
   * `services.stt.provider`. Callers that derive the provider themselves
   * (e.g. live voice, which runs on the managed-speech effective provider)
   * pass it here so the resolved transcriber matches the provider their own
   * readiness check approved.
   */
  providerId?: SttProviderId;
  /**
   * Consumer asking for the transcriber. Selects that role's
   * `services.stt.roles` override; omitted falls back to the global
   * `services.stt.provider`. Ignored when `providerId` is given, since that
   * caller already resolved the provider itself.
   */
  role?: SttRole;
  /**
   * Speaker diarization preference. Default: `"off"`.
   *
   * See {@link DiarizePreference} for semantics.
   */
  diarize?: DiarizePreference;
  /**
   * Emit `final` events only at utterance boundaries. Supported only by
   * providers whose catalog `telephonyMode` is `"realtime-ws"` (Deepgram,
   * where it also enables `utterance_end_ms` endpointing). All other
   * providers resolve to `null` so the caller falls back to per-turn
   * batch transcription — e.g. openai-whisper fires `final` only from
   * `stop()` (end-of-stream, not end-of-utterance) and xAI emits a
   * `final` per committed segment. Used by telephony call ingestion.
   * Default: false.
   */
  utteranceBoundaryFinals?: boolean;
  /**
   * Silence window (ms) the provider waits before finalizing an utterance
   * when `utteranceBoundaryFinals` is enabled (Deepgram `utterance_end_ms`).
   * Ignored without `utteranceBoundaryFinals`. Default: 1000.
   */
  utteranceEndMs?: number;
  /**
   * Spoken language to transcribe, forwarded to adapters that accept one.
   * Defaults to `services.stt.language`; pass explicitly to override the
   * config for a single session.
   *
   * Leaving both unset does not reach the adapters as "no language": on
   * Deepgram and the managed relay, where that would mean English rather
   * than detection, {@link effectiveSttLanguage} fills in code-switching
   * first. See {@link CreateStreamingTranscriberOptions.language} for how
   * each adapter treats what it finally receives.
   */
  language?: string;
}

/**
 * Resolve a `StreamingTranscriber` for daemon-hosted streaming transcription.
 *
 * Uses `options.providerId`, falling back to `services.stt.provider` from the
 * assistant config, verifies the provider supports the `daemon-streaming`
 * boundary, and constructs the appropriate streaming adapter. Credential
 * lookup is centralized here (an authorized secure-keys importer) so callers
 * don't need to import secure-keys directly.
 *
 * Returns `null` when:
 * - The resolved provider is not in the catalog.
 * - The resolved provider doesn't support the `daemon-streaming` boundary.
 * - No credentials are configured for the resolved provider.
 * - No streaming adapter exists for the resolved provider.
 * - `diarize` is `"required"` but the resolved provider cannot diarize.
 * - `utteranceBoundaryFinals` is set but the resolved provider's catalog
 *   `telephonyMode` is not `"realtime-ws"`.
 */
export async function resolveStreamingTranscriber(
  options: ResolveStreamingTranscriberOptions = {},
): Promise<StreamingTranscriber | null> {
  // Snapshot the stt config once, before any await, so a concurrent config
  // change cannot pair one setting's old value with another's new value
  // (e.g. the old provider with the new language).
  const stt = getConfig().services.stt;
  const provider =
    options.providerId ?? sttCatalogKeyForRole(stt, options.role);
  if (options.providerId === undefined) {
    logRoleSelection(options.role, provider, resolveSttCatalogKey(stt));
  }
  // Config-level language applies to every streaming caller (live voice,
  // dictation, telephony) unless one overrides it for a single session, so
  // the setting lands in one place rather than at each call site. An unset
  // config falls to the provider's default (see `effectiveSttLanguage`),
  // which is where a caller passing no language gets multilingual rather
  // than a silent English pin.
  const language = effectiveSttLanguage(
    provider,
    options.language ?? stt.language,
  );
  const diarizePreference: DiarizePreference = options.diarize ?? "off";

  // Look up credential provider via the catalog.
  const credentialProviderName = getCredentialProvider(provider);
  if (!credentialProviderName) {
    return null;
  }

  // Verify the provider supports the daemon-streaming boundary.
  if (!supportsBoundary(provider, "daemon-streaming")) {
    return null;
  }

  // Boundary-requiring callers (telephony) can only stream on providers
  // whose catalog telephonyMode is "realtime-ws" (Deepgram gates finals on
  // utterance boundaries). Everything else fires `final` either only from
  // stop() — end-of-stream, not end-of-utterance (openai-whisper) — or per
  // committed segment (xAI), so streaming would yield no replies until
  // hangup, or mid-sentence replies. Resolve to null so the caller falls
  // back to per-turn batch transcription.
  if (options.utteranceBoundaryFinals) {
    const telephonyMode = getProviderEntry(provider)?.telephonyMode;
    if (telephonyMode !== "realtime-ws") {
      log.warn(
        { providerId: provider, telephonyMode },
        "utterance-boundary finals requested but the configured STT provider has no realtime telephony streaming — falling back to batch transcription",
      );
      return null;
    }
  }

  // Resolve diarization capability against the catalog. For `"required"`
  // callers, bail early (with a warning) when the configured provider can't
  // diarize so the caller can surface a clear error to the user.
  const providerSupportsDiarization = supportsDiarization(provider);
  if (diarizePreference === "required" && !providerSupportsDiarization) {
    log.warn(
      { providerId: provider },
      "diarization is required but configured STT provider does not support it",
    );
    return null;
  }
  const enableDiarization =
    (diarizePreference === "preferred" || diarizePreference === "required") &&
    providerSupportsDiarization;

  // Both managed entries authenticate with the platform connection, not a
  // stored API key: there is no key to fetch, and readiness is whether the
  // connection resolves.
  const managed = isManagedSttProvider(provider);
  const apiKey = managed
    ? null
    : await getProviderKeyAsync(credentialProviderName);
  if (managed) {
    if (!(await sttProviderKeyResolves("vellum"))) {
      return null;
    }
  } else if (!apiKey) {
    return null;
  }

  return createStreamingTranscriber(apiKey ?? "", provider, {
    sampleRate: options.sampleRate,
    diarize: enableDiarization,
    utteranceBoundaryFinals: options.utteranceBoundaryFinals ?? false,
    utteranceEndMs: options.utteranceEndMs,
    ...(language ? { language } : {}),
  });
}

/**
 * Default Deepgram `utterance_end_ms` used when utterance-boundary finals
 * are requested and the caller supplies no override. This is the pause
 * length after which an `UtteranceEnd` frame confirms the utterance is
 * complete even when `speech_final` endpointing never fired (e.g.
 * background noise). Telephony callers override it via
 * `calls.voice.utteranceEndMs`.
 */
const UTTERANCE_BOUNDARY_END_MS = 1_000;

/**
 * Options forwarded to individual streaming adapter constructors.
 */
interface CreateStreamingTranscriberOptions {
  sampleRate?: number;
  /**
   * Whether to enable speaker diarization on providers that support it.
   * Only forwarded to provider adapters that accept a diarize option
   * (e.g. Deepgram). Silently ignored by adapters without diarization
   * support.
   */
  diarize?: boolean;
  /**
   * Whether `final` events should be gated on utterance boundaries.
   * Only forwarded to Deepgram; the resolver never sets this for
   * providers without realtime telephony streaming (they resolve to
   * `null` instead).
   */
  utteranceBoundaryFinals?: boolean;
  /**
   * Silence window (ms) before an utterance is finalized. Only forwarded
   * to Deepgram (as `utterance_end_ms`) when `utteranceBoundaryFinals`
   * is set. Defaults to {@link UTTERANCE_BOUNDARY_END_MS}.
   */
  utteranceEndMs?: number;
  /**
   * Spoken language, forwarded to the adapters that accept one: Deepgram,
   * xAI, and the managed relay (which passes it to Deepgram server-side).
   *
   * Gemini and Whisper take no language option (both auto-detect natively
   * from the audio), so this is silently ignored for them, matching how
   * `diarize` is ignored by adapters without diarization.
   *
   * Unset is NOT auto-detect on Deepgram: omitting the param makes Deepgram
   * decode as English, so non-English speech comes back as English-sounding
   * nonsense rather than failing loudly. Any configured language pins
   * nova-3 on BYOK Deepgram (see `deepgramLanguageOptions`); `"multi"`
   * selects nova-3's code-switching mode (the managed relay pins nova-3
   * server-side).
   */
  language?: string;
}

/**
 * Create a `StreamingTranscriber` for the given provider.
 *
 * Uses lazy imports so the adapter modules are only loaded when needed,
 * keeping the module graph lightweight for callers that only need batch
 * transcription.
 *
 * Returns `null` for providers that do not have a streaming adapter.
 */
async function createStreamingTranscriber(
  apiKey: string,
  providerId: SttProviderId,
  options: CreateStreamingTranscriberOptions = {},
): Promise<StreamingTranscriber | null> {
  switch (providerId) {
    case "deepgram": {
      const { DeepgramRealtimeTranscriber } =
        await import("./deepgram-realtime.js");
      // Lazy like the xai case's xaiLanguageOptions import: pulling the
      // batch adapter module in at top level would defeat the lazy module
      // graph this factory documents.
      const { deepgramLanguageOptions } = await import("./deepgram.js");
      return new DeepgramRealtimeTranscriber(apiKey, {
        sampleRate: options.sampleRate,
        ...deepgramLanguageOptions(options.language),
        ...(options.diarize ? { diarize: true } : {}),
        ...(options.utteranceBoundaryFinals
          ? {
              utteranceBoundaryFinals: true,
              utteranceEndMs:
                options.utteranceEndMs ?? UTTERANCE_BOUNDARY_END_MS,
            }
          : {}),
      });
    }
    case "google-gemini": {
      // Gemini does not support speaker diarization; the diarize option is
      // silently ignored here.
      const { GoogleGeminiLiveStreamingTranscriber } =
        await import("./google-gemini-live-stream.js");
      return new GoogleGeminiLiveStreamingTranscriber(apiKey, {
        pcmSampleRate: options.sampleRate,
      });
    }
    case "openai-whisper": {
      // OpenAI Whisper does not support speaker diarization; the diarize
      // option is silently ignored here.
      const { OpenAIWhisperStreamingTranscriber } =
        await import("./openai-whisper-stream.js");
      return new OpenAIWhisperStreamingTranscriber(apiKey, {
        pcmSampleRate: options.sampleRate,
      });
    }
    case "xai": {
      const { XAIRealtimeTranscriber } = await import("./xai-realtime.js");
      const { xaiLanguageOptions } = await import("./xai.js");
      return new XAIRealtimeTranscriber(apiKey, {
        sampleRate: options.sampleRate,
        // Drops "multi" (a Deepgram-specific mode, not a language code); see
        // xaiLanguageOptions.
        ...xaiLanguageOptions(options.language),
        ...(options.diarize ? { diarize: true } : {}),
      });
    }
    case "vellum": {
      // Managed speech dials the GATEWAY's speech relay (velay contact is
      // gateway-only); the apiKey argument is unused. Diarization is
      // unsupported (not in the relay's param allowlist) and silently
      // ignored, matching Gemini/Whisper — as is utteranceEndMs (the relay
      // allowlist has no utterance_end_ms; boundary finals ride on
      // endpointing alone).
      // The gateway is the credential authority, but the platform
      // connection (API key + assistant ID) is checkable locally — gate
      // here so preflight reports "connect your account" instead of
      // resolving a transcriber whose dial is doomed.
      const { vellumManagedSpeechAvailable } =
        await import("./vellum-managed.js");
      if (!(await vellumManagedSpeechAvailable())) {
        return null;
      }
      const { resolveSpeechRelayConnection } =
        await import("./vellum-speech-relay-connection.js");
      const connection = await resolveSpeechRelayConnection();
      if (!connection) {
        return null;
      }
      const { VellumManagedRealtimeTranscriber } =
        await import("./vellum-managed-realtime.js");
      return new VellumManagedRealtimeTranscriber(connection, {
        sampleRate: options.sampleRate,
        // `language` IS in the relay's param allowlist, and the relay pins
        // the STT model to nova-3 server-side, so "multi" code-switching
        // needs nothing from the platform, only this forward. Source:
        // vellum-assistant-platform: velay/internal/velay/deepgram.go
        // (deepgramSTTParams allowlist; deepgramSTTModel pin).
        ...(options.language ? { language: options.language } : {}),
        ...(options.utteranceBoundaryFinals
          ? { utteranceBoundaryFinals: true }
          : {}),
      });
    }
    case "vellum-flux": {
      // Managed Flux: same relay as `vellum`, but the STT v2 endpoint with
      // `contract=flux` so the turn events arrive intact instead of being
      // translated into the released v1 Deepgram dialect. Gated on the local
      // platform connection for the same reason as `vellum` above.
      const { vellumManagedSpeechAvailable } =
        await import("./vellum-managed.js");
      if (!(await vellumManagedSpeechAvailable())) {
        return null;
      }
      // The relay maps the language onto a Flux model and refuses the dial
      // when there is none, so a language outside Flux's roster fails as a
      // relay param error the caller cannot explain. Refuse here instead, on
      // the same rule the BYOK twin above applies, so the reason is named
      // where it can be read.
      const { fluxModelForLanguage: managedFluxModelForLanguage } =
        await import("./deepgram-flux-frames.js");
      if (managedFluxModelForLanguage(options.language) === null) {
        log.warn(
          { providerId, language: options.language },
          "Managed Flux has no model for the configured language; refusing rather than transcribing it as another",
        );
        return null;
      }
      const { resolveSpeechRelayConnection } =
        await import("./vellum-speech-relay-connection.js");
      const connection = await resolveSpeechRelayConnection();
      if (!connection) {
        return null;
      }
      const { VellumManagedFluxRealtimeTranscriber } =
        await import("./vellum-managed-flux-realtime.js");
      return new VellumManagedFluxRealtimeTranscriber(connection, {
        sampleRate: options.sampleRate,
        // The relay picks `flux-general-en` or `flux-general-multi` from
        // this, so it is the only lever over the Flux model from here.
        // `utteranceBoundaryFinals` is a nova-3 concept and the catalog
        // keeps this provider off telephony, so it never arrives.
        ...(options.language ? { language: options.language } : {}),
      });
    }
    case "deepgram-flux": {
      // Flux is streaming-only and dials Deepgram's /v2/listen conversational
      // endpoint. Turn-detection tuning comes from `liveVoice.flux`, which the
      // adapter reads itself. The language picks the model, so a language Flux
      // has no model for resolves to nothing rather than being transcribed by
      // the English one, which returns fluent-looking nonsense the transcript
      // gives no sign of. Diarization is off in the catalog, so a `"required"`
      // caller never reaches this case.
      const { fluxModelForLanguage } =
        await import("./deepgram-flux-frames.js");
      // A pinned model is the operator saying which one to run, so the
      // language check only guards the derived case.
      if (
        getConfig().liveVoice.flux.model === undefined &&
        fluxModelForLanguage(options.language) === null
      ) {
        log.warn(
          { providerId, language: options.language },
          "Deepgram Flux has no model for the configured language; refusing rather than transcribing it as another",
        );
        return null;
      }
      const { DeepgramFluxRealtimeTranscriber } =
        await import("./deepgram-flux-realtime.js");
      return new DeepgramFluxRealtimeTranscriber(apiKey, {
        sampleRate: options.sampleRate,
        ...(options.language ? { language: options.language } : {}),
      });
    }
    default: {
      const _exhaustive: never = providerId;
      return null;
    }
  }
}

/**
 * True when an API key resolves for the given credential provider name.
 *
 * Centralized here (an authorized secure-keys importer) so callers that only
 * need a key-existence check don't import secure-keys directly.
 */
/**
 * Human-readable reason for a credential gap, aware that connection-based
 * providers (vellum) are fixed by connecting the platform account, not by
 * entering an API key.
 */
export function sttCredentialGapReason(credentialProviderName: string): string {
  if (credentialProviderName === "vellum") {
    return "No Vellum platform connection for managed speech — run 'assistant platform connect'";
  }
  return `No API key configured for credential provider "${credentialProviderName}"`;
}

export async function sttProviderKeyResolves(
  credentialProviderName: string,
): Promise<boolean> {
  // vellum has no stored API key — the platform connection is the credential.
  if (credentialProviderName === "vellum") {
    const { vellumManagedSpeechAvailable } =
      await import("./vellum-managed.js");
    return vellumManagedSpeechAvailable();
  }
  return (await getProviderKeyAsync(credentialProviderName)) !== undefined;
}

/**
 * STT provider catalog — single source of truth for provider metadata.
 *
 * Every STT provider is described by a {@link SttProviderEntry} that
 * captures its canonical ID, the credential-provider name used to look up
 * API keys, supported runtime boundaries, and telephony support mode.
 *
 * All other modules that need provider metadata (resolve.ts,
 * daemon-batch-transcriber.ts, future telephony adapters) read from this
 * catalog rather than maintaining their own hardcoded maps.
 */

import type {
  ConversationStreamingMode,
  SttBoundaryId,
  SttModelFamily,
  SttProviderId,
  SttTurnDetectionMode,
  TelephonySttMode,
} from "../../stt/types.js";
import { baseLanguageSubtag } from "../../util/language-subtag.js";
import { FLUX_MULTILINGUAL_SUBTAGS } from "./deepgram-flux-frames.js";

// ---------------------------------------------------------------------------
// Client display metadata
// ---------------------------------------------------------------------------

/** How the provider's credentials are configured by the user. */
type SttSetupMode = "api-key" | "cli" | "connection";

/** Guide for obtaining API credentials from a provider. */
interface SttCredentialsGuide {
  readonly description: string;
  readonly url: string;
  readonly linkLabel: string;
}

// ---------------------------------------------------------------------------
// Catalog entry
// ---------------------------------------------------------------------------

/**
 * Metadata for a single STT provider.
 */
interface SttProviderEntry {
  /** Canonical provider identifier (must match an {@link SttProviderId} variant). */
  readonly id: SttProviderId;

  /** Human-readable name for display in settings UI. */
  readonly displayName: string;

  /** Short description shown below the provider selector. */
  readonly subtitle: string;

  /** How the provider's credentials are configured. */
  readonly setupMode: SttSetupMode;

  /** Brief help text guiding the user through setup. */
  readonly setupHint: string;

  /**
   * Name of the credential provider used by `getProviderKeyAsync` to
   * retrieve the API key. Multiple STT providers may share a credential
   * provider (e.g. a future "openai-realtime" provider would also map to
   * `"openai"`).
   */
  readonly credentialProvider: string;

  /**
   * Set of runtime boundaries this provider supports. A provider may
   * support more than one boundary (e.g. both `daemon-batch` and a future
   * `realtime-ws` boundary).
   */
  readonly supportedBoundaries: ReadonlySet<SttBoundaryId>;

  /**
   * Telephony capability class — describes the provider's native
   * audio-ingestion capability for telephony contexts.
   */
  readonly telephonyMode: TelephonySttMode;

  /**
   * Conversation streaming mode — describes whether and how the provider
   * can participate in real-time conversation chat message capture
   * (chat composer and iOS input bar).
   *
   * - `"realtime-ws"` — native WebSocket streaming with partial/final events.
   * - `"incremental-batch"` — polling-based incremental batch approximation.
   * - `"none"` — no streaming support; fall back to batch transcription.
   */
  readonly conversationStreamingMode: ConversationStreamingMode;

  /**
   * Whether the provider decides end-of-turn itself, in-band with the audio
   * it transcribes, or leaves the boundary to the session's local silence
   * timer. A live-voice session reads this to decide whether to arm its
   * provider turn-end path; it never names a provider directly.
   */
  readonly turnDetection: SttTurnDetectionMode;

  /**
   * Whether the provider can attribute transcribed speech to distinct
   * speakers (speaker diarization). When `true`, callers may opt in to
   * per-utterance speaker labels via the provider's streaming/batch
   * configuration. When `false`, speaker-label callers must fall back to
   * single-speaker output.
   *
   * Flip this flag in the catalog if a provider gains diarization support;
   * downstream code reads the capability from here via
   * {@link supportsDiarization}.
   */
  readonly supportsDiarization: boolean;

  /**
   * How the provider handles transcription language.
   *
   * - `"manual"`: the provider accepts an explicit language parameter and
   *   defaults to English when omitted; a language picker is meaningful.
   * - `"auto"`: the provider takes no language parameter, either because it
   *   detects the language natively or because its model is monolingual; a
   *   picker would be a no-op, so clients must hide it.
   */
  readonly languageSelection: "manual" | "auto";

  /** Guide for obtaining API credentials from this provider. */
  readonly credentialsGuide?: SttCredentialsGuide;

  /**
   * Set when this row is a model family of another provider rather than a
   * provider in its own right: the id a user selects, plus the
   * `services.stt.providers.<id>.model` value that reaches this row.
   *
   * Rows carrying this are not separately selectable. They share the parent's
   * credential and appear nowhere in a provider picker.
   */
  readonly variantOf?: SttProviderId;
  readonly variantModel?: SttModelFamily;

  /**
   * The family this row runs when no `model` is set. Present only on rows that
   * have variants, so the default is nameable in config and in errors.
   */
  readonly baseModelFamily?: SttModelFamily;
}

// ---------------------------------------------------------------------------
// Catalog data
// ---------------------------------------------------------------------------

/**
 * Shared by every provider that authenticates against a Deepgram account.
 * The key is the same one, so the instructions must not drift apart.
 */
const DEEPGRAM_CREDENTIALS_GUIDE: SttCredentialsGuide = {
  description:
    "Sign in to the Deepgram console, navigate to API Keys, and create a new key.",
  url: "https://console.deepgram.com/",
  linkLabel: "Open Deepgram Console",
};

/**
 * Provider catalog entries, keyed by provider ID.
 *
 * To add a new STT provider:
 * 1. Add a new variant to `SttProviderId` in `stt/types.ts`.
 * 2. Add an entry here with the credential mapping and boundary support.
 * 3. Wire up the adapter in `daemon-batch-transcriber.ts` (and/or a
 *    future realtime adapter) for the boundaries the provider supports.
 */
const CATALOG: ReadonlyMap<SttProviderId, SttProviderEntry> = new Map<
  SttProviderId,
  SttProviderEntry
>([
  [
    "deepgram",
    {
      id: "deepgram",
      baseModelFamily: "nova-3",
      displayName: "Deepgram",
      subtitle:
        "Fast, real-time speech-to-text with streaming support. Requires a Deepgram API key.",
      setupMode: "api-key",
      setupHint: "Enter your Deepgram API key to enable speech-to-text.",
      credentialProvider: "deepgram",
      supportedBoundaries: new Set<SttBoundaryId>([
        "daemon-batch",
        "daemon-streaming",
      ]),
      telephonyMode: "realtime-ws",
      conversationStreamingMode: "realtime-ws",
      turnDetection: "none",
      supportsDiarization: true,
      languageSelection: "manual",
      credentialsGuide: DEEPGRAM_CREDENTIALS_GUIDE,
    },
  ],
  [
    "deepgram-flux",
    {
      id: "deepgram-flux",
      variantOf: "deepgram",
      variantModel: "flux",
      displayName: "Deepgram Flux",
      subtitle:
        "Conversational speech-to-text with model-native turn detection. Uses your Deepgram API key.",
      setupMode: "api-key",
      setupHint:
        "Enter your Deepgram API key. Flux shares the same key as Deepgram.",
      // Shared with the `deepgram` provider: Flux is a model on the same
      // account, not a separate credential.
      credentialProvider: "deepgram",
      // Streaming only: Flux has no batch endpoint.
      supportedBoundaries: new Set<SttBoundaryId>(["daemon-streaming"]),
      // Telephony is out of scope for the spike. Nothing reroutes a call to
      // another provider, so a Flux-configured assistant does not transcribe
      // calls at all.
      telephonyMode: "none",
      conversationStreamingMode: "realtime-ws",
      // Flux emits turn lifecycle events on its transcript stream and numbers
      // them, so a live-voice session may let them commit the turn.
      turnDetection: "provider",
      supportsDiarization: false,
      // "no picker", not native detection: this entry pins the English Flux
      // model and sends no language parameter, so audio in another language
      // transcribes as English. Flux itself has a multilingual model; the
      // managed `vellum-flux` entry reaches it, and a BYOK picker would need
      // the model to follow the selection.
      languageSelection: "auto",
      credentialsGuide: DEEPGRAM_CREDENTIALS_GUIDE,
    },
  ],
  [
    "google-gemini",
    {
      id: "google-gemini",
      displayName: "Google Gemini",
      subtitle:
        "Multimodal speech-to-text powered by Google Gemini. Requires a Gemini API key.",
      setupMode: "api-key",
      setupHint:
        "Enter your Gemini API key to enable Google Gemini transcription.",
      credentialProvider: "gemini",
      supportedBoundaries: new Set<SttBoundaryId>([
        "daemon-batch",
        "daemon-streaming",
      ]),
      telephonyMode: "batch-only",
      conversationStreamingMode: "realtime-ws",
      turnDetection: "none",
      supportsDiarization: false,
      languageSelection: "auto",
      credentialsGuide: {
        description:
          "Visit Google AI Studio, sign in with your Google account, and create an API key.",
        url: "https://aistudio.google.com/apikey",
        linkLabel: "Open Google AI Studio",
      },
    },
  ],
  [
    "openai-whisper",
    {
      id: "openai-whisper",
      displayName: "OpenAI Whisper",
      subtitle:
        "High-accuracy speech-to-text powered by OpenAI Whisper. Requires an OpenAI API key.",
      setupMode: "api-key",
      setupHint: "Enter your OpenAI API key to enable Whisper transcription.",
      credentialProvider: "openai",
      supportedBoundaries: new Set<SttBoundaryId>([
        "daemon-batch",
        "daemon-streaming",
      ]),
      telephonyMode: "batch-only",
      conversationStreamingMode: "incremental-batch",
      turnDetection: "none",
      supportsDiarization: false,
      languageSelection: "auto",
      credentialsGuide: {
        description:
          "Log in to the OpenAI platform, go to API Keys, and generate a new secret key.",
        url: "https://platform.openai.com/api-keys",
        linkLabel: "Open OpenAI Platform",
      },
    },
  ],
  [
    "vellum",
    {
      id: "vellum",
      baseModelFamily: "nova-3",
      displayName: "Vellum",
      subtitle:
        "Speech-to-text through your Vellum account — billed to Vellum credits, no separate API key needed.",
      setupMode: "connection",
      setupHint: "Connect your Vellum account to enable managed transcription.",
      credentialProvider: "vellum",
      supportedBoundaries: new Set<SttBoundaryId>([
        "daemon-batch",
        "daemon-streaming",
      ]),
      telephonyMode: "realtime-ws",
      conversationStreamingMode: "realtime-ws",
      turnDetection: "none",
      supportsDiarization: false,
      // The relay dials Deepgram nova-3 server-side, which takes an explicit
      // language parameter.
      languageSelection: "manual",
    },
  ],
  [
    "vellum-flux",
    {
      id: "vellum-flux",
      variantOf: "vellum",
      variantModel: "flux",
      displayName: "Vellum (Flux)",
      subtitle:
        "Conversational speech-to-text with model-native turn detection, through your Vellum account. No separate API key needed.",
      setupMode: "connection",
      setupHint: "Connect your Vellum account to enable managed transcription.",
      // Shared with `vellum`: the platform connection is the credential, and
      // Flux is a different endpoint on the same relay, not a second account.
      credentialProvider: "vellum",
      // Streaming only, same as the BYOK Flux entry: Flux has no batch
      // endpoint, and the relay exposes none.
      supportedBoundaries: new Set<SttBoundaryId>(["daemon-streaming"]),
      // The relay maps `Finalize` onto Flux's `CloseStream`, which ends the
      // session rather than flushing it, and telephony's utterance-boundary
      // finals are a nova-3 concept. Calls stay on `vellum`.
      telephonyMode: "none",
      conversationStreamingMode: "realtime-ws",
      // The relay is dialed with `contract=flux`, so Flux's turn lifecycle
      // events arrive intact and a live-voice session may let them commit
      // the turn. Without that opt-in the relay translates them away and
      // this would be false.
      turnDetection: "provider",
      supportsDiarization: false,
      // The relay selects `flux-general-en` or `flux-general-multi` from the
      // language it is sent, so unlike BYOK Flux the picker is meaningful.
      languageSelection: "manual",
    },
  ],
  [
    "xai",
    {
      id: "xai",
      displayName: "xAI",
      subtitle:
        "Real-time speech-to-text powered by xAI. Requires an xAI API key.",
      setupMode: "api-key",
      setupHint: "Enter your xAI API key to enable xAI transcription.",
      credentialProvider: "xai",
      supportedBoundaries: new Set<SttBoundaryId>([
        "daemon-batch",
        "daemon-streaming",
      ]),
      telephonyMode: "batch-only",
      conversationStreamingMode: "realtime-ws",
      turnDetection: "none",
      supportsDiarization: true,
      languageSelection: "manual",
      credentialsGuide: {
        description:
          "Sign in to the xAI console, navigate to API Keys, and create a new key.",
        url: "https://console.x.ai/",
        linkLabel: "Open xAI Console",
      },
    },
  ],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a provider entry by its canonical ID.
 *
 * Returns `undefined` when the ID is not present in the catalog (e.g. an
 * unknown runtime value that passed schema validation).
 */
export function getProviderEntry(
  id: SttProviderId,
): SttProviderEntry | undefined {
  return CATALOG.get(id);
}

/**
 * Return all catalog entries in deterministic (insertion) order.
 */
export function listProviderEntries(): readonly SttProviderEntry[] {
  return [...CATALOG.values()];
}

/**
 * A base-subtag regex over the pinned listening language. The pin is
 * free-form workspace config, and it flows into prompt interpolation and
 * per-language table lookups, so only a plausible ISO 639 base subtag
 * passes; anything else (junk strings, prototype keys like "constructor")
 * resolves as no pin.
 */
const PINNED_LANGUAGE_SUBTAG_REGEX = /^[a-z]{2,3}$/;

/**
 * The configured `services.stt.language` pin as the caller's listening
 * language, or undefined when the pin carries no signal.
 *
 * A persisted pin only counts when the provider honors manual language
 * selection: auto-detecting providers (gemini, whisper) ignore the setting
 * entirely, so treating it as the caller's language would force every
 * turn into a stale pin. "multi" and blank mean auto-detect (no pin), and
 * the value must normalize to a plausible base subtag. Shared by the
 * telephony pre-speech prompt rule (voice-session-bridge.ts), live
 * voice's turn language (live-voice-session.ts), and telephony synthesis
 * (telephony-synthesis-language.ts) so the gate cannot drift.
 */
export function pinnedListeningLanguage(
  provider: string,
  configuredLanguage: string | undefined,
): string | undefined {
  const providerHonorsLanguagePin =
    getProviderEntry(provider as SttProviderId)?.languageSelection === "manual";
  if (!providerHonorsLanguagePin || configuredLanguage?.trim() === "multi") {
    return undefined;
  }
  const base = baseLanguageSubtag(configuredLanguage);
  return base !== undefined && PINNED_LANGUAGE_SUBTAG_REGEX.test(base)
    ? base
    : undefined;
}

/**
 * Look up the credential-provider name for a given STT provider.
 *
 * Convenience wrapper around `getProviderEntry` for callers that only need
 * the credential mapping. Returns `undefined` when the provider is unknown.
 */
export function getCredentialProvider(id: SttProviderId): string | undefined {
  return CATALOG.get(id)?.credentialProvider;
}

/**
 * Check whether a provider supports a specific runtime boundary.
 *
 * Returns `false` for unknown provider IDs.
 */
export function supportsBoundary(
  id: SttProviderId,
  boundary: SttBoundaryId,
): boolean {
  return CATALOG.get(id)?.supportedBoundaries.has(boundary) ?? false;
}

/**
 * Message explaining why a provider cannot serve the `daemon-batch` boundary.
 *
 * Streaming-only providers are selected through the same
 * `services.stt.provider` key as batch-capable ones, so a batch caller that
 * reports only "nothing is configured" points the operator at the wrong
 * problem. This names the provider and, where one exists, the batch-capable
 * provider on the same credential, so acting on it needs no catalog reading.
 */
export function batchBoundaryGapReason(id: SttProviderId): string {
  const entry = CATALOG.get(id);
  const label = entry?.displayName ?? id;
  const alternative = entry
    ? [...CATALOG.values()].find(
        (candidate) =>
          candidate.id !== entry.id &&
          candidate.credentialProvider === entry.credentialProvider &&
          candidate.supportedBoundaries.has("daemon-batch"),
      )
    : undefined;
  const remedy = alternative
    ? `Batch transcription requires the ${alternative.id} provider: set services.stt.provider to "${alternative.id}".`
    : "Set services.stt.provider to a provider that supports batch transcription.";
  return `${label} is streaming-only. ${remedy}`;
}

/**
 * Check whether a provider supports speaker diarization.
 *
 * Returns `false` for unknown provider IDs. Callers use this to decide
 * whether to request speaker labels from the provider's streaming or
 * batch configuration.
 */
export function supportsDiarization(id: SttProviderId): boolean {
  return CATALOG.get(id)?.supportsDiarization ?? false;
}

/**
 * Check whether a provider decides end-of-turn itself.
 *
 * Returns `false` for unknown provider IDs, which keeps an unrecognized
 * provider on the local silence boundary rather than waiting for turn events
 * that will never arrive. A live-voice session reads this instead of naming a
 * provider, so a new turn-detecting provider is a catalog entry rather than a
 * session change.
 */
/**
 * Whether a provider authenticates with the Vellum platform connection rather
 * than a stored API key.
 *
 * Derived from the catalog rather than a hand-kept id list: every check that
 * gates managed speech reads this, so adding a managed provider cannot leave
 * one of them behind on a stale literal.
 */
export function isManagedSttProvider(id: SttProviderId): boolean {
  return CATALOG.get(id)?.credentialProvider === "vellum";
}

/**
 * The catalog row a configured provider plus model family resolves to.
 *
 * Falls back to the provider's own row when it offers no matching variant, so
 * a model setting a provider does not implement is inert rather than fatal.
 * The parameter is structural to keep the catalog free of config imports.
 */
export function resolveSttCatalogKey(stt: {
  readonly provider: string;
  readonly providers?:
    | Record<string, { readonly model?: unknown } | undefined>
    | undefined;
}): SttProviderId {
  const provider = stt.provider as SttProviderId;
  return sttCatalogKeyFor(provider, stt.providers?.[provider]?.model);
}

/**
 * The catalog row a provider and model family pair resolves to.
 *
 * Split out from {@link resolveSttCatalogKey} because a selection does not
 * always come from the top-level config block: a per-consumer role names its
 * own provider and family, and has to reach the same row that pair would
 * reach anywhere else.
 */
export function sttCatalogKeyFor(
  provider: SttProviderId,
  model: unknown,
): SttProviderId {
  if (typeof model !== "string") {
    return provider;
  }
  for (const entry of CATALOG.values()) {
    if (entry.variantOf === provider && entry.variantModel === model) {
      return entry.id;
    }
  }
  return provider;
}

/**
 * The model families a provider offers, as `services.stt.providers.<id>.model`
 * values. A provider with a single family returns an empty list, and setting
 * `model` on it is a configuration error rather than a silent no-op.
 */
export function listProviderModelFamilies(
  id: SttProviderId,
): readonly SttModelFamily[] {
  const base = CATALOG.get(id);
  if (!base || base.variantOf !== undefined) {
    return [];
  }
  const families = [...CATALOG.values()]
    .filter((entry) => entry.variantOf === id && entry.variantModel)
    .map((entry) => entry.variantModel as SttModelFamily);
  return families.length > 0
    ? [base.baseModelFamily ?? "nova-3", ...families]
    : [];
}

/**
 * The config that selects a catalog row: the provider id a user sets, plus
 * the model family when the row is a variant.
 *
 * The inverse of {@link resolveSttCatalogKey}. Anything persisting a resolved
 * provider has to write these two fields rather than the key, which is not a
 * valid `services.stt.provider` value for a variant row.
 */
export function sttConfigForCatalogKey(id: SttProviderId): {
  provider: SttProviderId;
  model?: SttModelFamily;
} {
  const entry = CATALOG.get(id);
  if (!entry?.variantOf || !entry.variantModel) {
    return { provider: id };
  }
  return { provider: entry.variantOf, model: entry.variantModel };
}

/**
 * The family a provider runs when no `model` is set, for callers that must
 * write an explicit value rather than leave a stale one in place. Providers
 * with a single family have no name to write and return undefined.
 */
/**
 * The spoken languages a provider's turn-detecting model family serves, or
 * undefined when it has no such family.
 *
 * A family that owns the turn boundary does not necessarily cover the
 * provider's whole language roster, and dialing it outside that set fails
 * rather than degrades. Reported from here so the answer has one home.
 */
export function turnDetectionLanguagesFor(
  id: SttProviderId,
): readonly string[] | undefined {
  const variant = [...CATALOG.values()].find(
    (entry) => entry.variantOf === id && entry.turnDetection === "provider",
  );
  return variant ? [...FLUX_MULTILINGUAL_SUBTAGS].sort() : undefined;
}

export function baseModelFamilyFor(
  id: SttProviderId,
): SttModelFamily | undefined {
  const entry = CATALOG.get(id);
  return entry?.variantOf === undefined ? entry?.baseModelFamily : undefined;
}

/**
 * Provider ids a user may select. Excludes model-family rows, which are
 * reached through `services.stt.providers.<id>.model` instead.
 */
export function listSelectableProviderIds(): readonly SttProviderId[] {
  return [...CATALOG.values()]
    .filter((entry) => entry.variantOf === undefined)
    .map((entry) => entry.id);
}

export function supportsProviderTurnDetection(id: SttProviderId): boolean {
  return CATALOG.get(id)?.turnDetection === "provider";
}

/**
 * Return all canonical provider IDs in deterministic (insertion) order.
 */
export function listProviderIds(): readonly SttProviderId[] {
  return [...CATALOG.keys()];
}

/**
 * Return the deduplicated set of credential-provider names used by STT
 * providers, in deterministic (first-seen) order.
 *
 * Multiple STT providers may share a single credential provider (e.g.
 * `openai-whisper` and a future `openai-realtime` both map to `"openai"`).
 * This helper deduplicates so that callers composing API-key provider
 * lists do not produce duplicate entries.
 */
export function listCredentialProviderNames(): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of CATALOG.values()) {
    // Connection-based providers (vellum) authenticate via the platform
    // connection, not a stored API key — offering them on the generic
    // key routes would accept a key that never enables anything.
    if (entry.setupMode !== "api-key") {
      continue;
    }
    if (!seen.has(entry.credentialProvider)) {
      seen.add(entry.credentialProvider);
      result.push(entry.credentialProvider);
    }
  }
  return result;
}

/**
 * Managed-speech defaulting.
 *
 * When the platform connection is usable and a speech service has no working
 * BYOK credential, that service's effective provider is `"vellum"` so a fresh
 * Vellum connection gets voice features with zero configuration. A service
 * whose BYOK credential is configured is never redirected — connecting Vellum
 * must not silently reroute an existing voice setup — and a service already on
 * Vellum is left alone.
 *
 * {@link resolveEffectiveSpeechProviders} is the single definition of that
 * rule. It writes nothing, so runtime paths that only need to know which
 * provider they will actually use (live-voice readiness, transcription,
 * synthesis) resolve the same ids the scope-gated writer
 * {@link maybeDefaultSpeechToManaged} would persist, without needing write
 * access to the config.
 */

import { ttsSecretResolves } from "../calls/telephony-tts-capability.js";
import { managedSpeechAvailable } from "../platform/managed-speech.js";
import { fluxModelForLanguage } from "../providers/speech-to-text/deepgram-flux-frames.js";
import {
  baseModelFamilyFor,
  getProviderEntry,
  isManagedSttProvider,
  resolveSttCatalogKey,
  sttConfigForCatalogKey,
  supportsProviderTurnDetection,
} from "../providers/speech-to-text/provider-catalog.js";
import { sttProviderKeyResolves } from "../providers/speech-to-text/resolve.js";
import {
  STT_ROLES,
  sttCatalogKeyForRole,
  type SttRole,
  sttRoleCapabilityGap,
  sttSelectionForRole,
} from "../stt/roles.js";
import type { SttProviderId } from "../stt/types.js";
import { getCatalogProvider } from "../tts/provider-catalog.js";
import type { TtsProviderId } from "../tts/types.js";
import { getLogger } from "../util/logger.js";
import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "./loader.js";
import type { AssistantConfig } from "./types.js";

const log = getLogger("managed-speech-defaults");

/** Whether the configured BYOK STT provider has a usable credential. */
async function sttByokCredentialResolves(provider: string): Promise<boolean> {
  const entry = getProviderEntry(provider as SttProviderId);
  if (!entry) {
    return false;
  }
  return sttProviderKeyResolves(entry.credentialProvider);
}

/** Whether the configured BYOK TTS provider has all its secrets. */
async function ttsByokCredentialsResolve(provider: string): Promise<boolean> {
  let entry;
  try {
    entry = getCatalogProvider(provider);
  } catch {
    return false;
  }
  for (const secret of entry.secretRequirements) {
    if (!(await ttsSecretResolves(secret.credentialStoreKey))) {
      return false;
    }
  }
  return true;
}

/**
 * The managed provider that stands in for a configured one whose credential
 * did not resolve.
 *
 * Managed speech has two STT entries, and they are not interchangeable:
 * `vellum-flux` decides end-of-turn itself, `vellum` leaves it to the
 * session's silence timer. Substituting the plain one for a provider that had
 * provider turn detection would keep live voice working while quietly
 * changing how it takes turns, which reads as "Flux is no better" rather than
 * as a missing credential. Match the capability instead.
 */
function managedStandInFor(
  configured: SttProviderId,
  language: string | undefined,
): SttProviderId {
  if (!supportsProviderTurnDetection(configured)) {
    return "vellum";
  }
  // Flux has a model for ten languages. Outside them the relay rejects the
  // dial outright, so standing in with it would hand the speaker a mic that
  // does not work at all rather than one that detects turns less well. The
  // language is the one the resolver will actually send.
  return fluxModelForLanguage(language) === null ? "vellum" : "vellum-flux";
}

/** The speech providers a runtime path uses, after managed-speech defaulting. */
export interface EffectiveSpeechProviders {
  stt: SttProviderId;
  tts: TtsProviderId;
}

/**
 * Resolve the speech providers the runtime actually uses.
 *
 * A configured service whose BYOK credential does not resolve is reported as
 * its managed stand-in while managed speech is available (see
 * {@link managedStandInFor}, which preserves provider turn detection); every
 * other service keeps its configured provider. Read-only: callers that hold no `settings.write`
 * scope (the live-voice WebSocket transport) resolve the same verdict the
 * preflight route does without persisting anything.
 *
 * `config` selects the configuration to read the configured providers from,
 * for callers already holding one (defaults to the loaded config). `role`
 * selects which consumer's STT override applies; omitting it reads the global
 * provider.
 */
export async function resolveEffectiveSpeechProviders(
  config?: AssistantConfig,
  options: { role?: SttRole } = {},
): Promise<EffectiveSpeechProviders> {
  const services = (config ?? getConfig()).services;
  const configuredStt = sttCatalogKeyForRole(services.stt, options.role);
  const configuredTts = services.tts.provider as TtsProviderId;

  if (!(await managedSpeechAvailable())) {
    return { stt: configuredStt, tts: configuredTts };
  }

  const stt =
    !isManagedSttProvider(configuredStt) &&
    !(await sttByokCredentialResolves(configuredStt))
      ? managedStandInFor(configuredStt, services.stt.language)
      : configuredStt;

  const tts =
    configuredTts !== "vellum" &&
    !(await ttsByokCredentialsResolve(configuredTts))
      ? "vellum"
      : configuredTts;

  return {
    stt: managedLiveVoiceModelFamily(stt, options.role, services.stt),
    tts,
  };
}

/**
 * Managed live voice runs Flux.
 *
 * Turn detection is the reason to reach for Flux at all, and managed users
 * cannot ask for it: the provider picker offers no model family, so `vellum`
 * is as specific as they can be. Deciding it here rather than persisting a
 * `services.stt.roles.liveVoice` entry keeps managed opinionated without
 * writing config on anyone's behalf, and reaches installs already on `vellum`
 * that a substitution rule never sees.
 *
 * Two things still win over it. A family the user named is honoured, because
 * `services.stt.providers.vellum.model` accepts `nova-3` and quietly ignoring
 * a valid setting is the silent substitution roles exist to prevent. And a
 * language outside Flux's roster stays on nova-3, since the relay refuses the
 * dial rather than degrading (see `managedStandInFor`).
 *
 * Live voice only: Flux streams and nothing else, so every other consumer
 * would lose its transcriber.
 */
function managedLiveVoiceModelFamily(
  resolved: SttProviderId,
  role: SttRole | undefined,
  stt: AssistantConfig["services"]["stt"],
): SttProviderId {
  if (role !== "liveVoice" || resolved !== "vellum") {
    return resolved;
  }
  if (sttSelectionForRole(stt, role).model !== undefined) {
    return resolved;
  }
  return fluxModelForLanguage(stt.language) === null ? "vellum" : "vellum-flux";
}

/**
 * Whether a provider can serve every consumer, or only the one that chose it.
 *
 * `vellum` covers every boundary, so substituting it is safe everywhere. A
 * narrowing row like `vellum-flux` streams and nothing else, and the roles it
 * fails are exactly the consumers that must not be moved onto it.
 */
function servesEveryRole(provider: SttProviderId): boolean {
  const selection = sttConfigForCatalogKey(provider);
  return STT_ROLES.every(
    (role) => sttRoleCapabilityGap(role, selection) === null,
  );
}

/**
 * The writes that put `selection` in force as the global provider.
 *
 * The family is always written, including the base one. Substituting away
 * from a variant leaves its `model` behind otherwise, and the next load
 * resolves straight back to the variant this substitution just rejected: the
 * provider would read as plain vellum while running Flux, with batch and
 * telephony quietly unavailable. A provider with no families has no name to
 * write, and no variant to have left a stale value behind either.
 */
function globalSttUpdates(selection: {
  provider: string;
  model?: string | undefined;
}): { path: string; provider: string }[] {
  const updates = [
    { path: "services.stt.provider", provider: selection.provider },
  ];
  const family =
    selection.model ?? baseModelFamilyFor(selection.provider as SttProviderId);
  if (family !== undefined) {
    updates.push({
      path: `services.stt.providers.${selection.provider}.model`,
      provider: family,
    });
  }
  return updates;
}

/**
 * Persist the effective speech providers resolved by
 * {@link resolveEffectiveSpeechProviders} whenever they differ from the
 * configured ones.
 *
 * Safe to call repeatedly (idempotent) and safe to fire-and-forget. Callers
 * must hold the `settings.write` scope — this is the only path that writes
 * `services.stt/tts.provider` on behalf of managed-speech defaulting.
 */
export async function maybeDefaultSpeechToManaged(): Promise<void> {
  try {
    const services = getConfig().services;
    const effective = await resolveEffectiveSpeechProviders();

    const updates: { path: string; provider: string }[] = [];
    if (effective.stt !== resolveSttCatalogKey(services.stt)) {
      // A variant row is not a valid services.stt.provider value, so persist
      // the pair that selects it. Writing the key itself would put an id the
      // schema rejects on disk, and an unparseable services block is how the
      // loader's salvage ladder ends up resetting the whole section.
      const standIn = sttConfigForCatalogKey(effective.stt);
      if (servesEveryRole(effective.stt)) {
        updates.push(...globalSttUpdates(standIn));
      } else {
        // A stand-in that cannot serve every consumer belongs to the one that
        // chose it. Live voice is that consumer: provider turn detection is
        // the only reason managedStandInFor reaches for a narrow row, and
        // writing that row globally would take batch transcription and
        // telephony from every other consumer in a single write.
        updates.push({
          path: "services.stt.roles.liveVoice.provider",
          provider: standIn.provider,
        });
        if (standIn.model !== undefined) {
          updates.push({
            path: "services.stt.roles.liveVoice.model",
            provider: standIn.model,
          });
        }
        // The other consumers still need a provider that answers, and the
        // narrow stand-in's own base is the managed row that serves them.
        if (servesEveryRole(standIn.provider as SttProviderId)) {
          updates.push(...globalSttUpdates({ provider: standIn.provider }));
        }
      }
    }
    if (effective.tts !== services.tts.provider) {
      updates.push({ path: "services.tts.provider", provider: effective.tts });
    }

    if (updates.length === 0) {
      return;
    }

    const raw = loadRawConfig();
    for (const { path, provider } of updates) {
      setNestedValue(raw, path, provider);
    }
    saveRawConfig(raw);
    invalidateConfigCache();
    log.info(
      { defaulted: updates.map(({ path }) => path) },
      "Defaulted unconfigured speech services to the Vellum provider after connection",
    );
  } catch (err) {
    // Convenience defaulting must never break credential storage.
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Managed speech defaulting failed (non-fatal)",
    );
  }
}

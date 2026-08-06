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
import { getProviderEntry } from "../providers/speech-to-text/provider-catalog.js";
import { sttProviderKeyResolves } from "../providers/speech-to-text/resolve.js";
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

/** The speech providers a runtime path uses, after managed-speech defaulting. */
export interface EffectiveSpeechProviders {
  stt: SttProviderId;
  tts: TtsProviderId;
}

/**
 * Resolve the speech providers the runtime actually uses.
 *
 * A configured service whose BYOK credential does not resolve is reported as
 * `"vellum"` while managed speech is available; every other service keeps its
 * configured provider. Read-only — callers that hold no `settings.write`
 * scope (the live-voice WebSocket transport) resolve the same verdict the
 * preflight route does without persisting anything.
 *
 * `config` selects the configuration to read the configured providers from,
 * for callers already holding one (defaults to the loaded config).
 */
export async function resolveEffectiveSpeechProviders(
  config?: AssistantConfig,
): Promise<EffectiveSpeechProviders> {
  const services = (config ?? getConfig()).services;
  const configuredStt = services.stt.provider as SttProviderId;
  const configuredTts = services.tts.provider as TtsProviderId;

  if (!(await managedSpeechAvailable())) {
    return { stt: configuredStt, tts: configuredTts };
  }

  const stt =
    configuredStt !== "vellum" &&
    !(await sttByokCredentialResolves(configuredStt))
      ? "vellum"
      : configuredStt;

  const tts =
    configuredTts !== "vellum" &&
    !(await ttsByokCredentialsResolve(configuredTts))
      ? "vellum"
      : configuredTts;

  return { stt, tts };
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
    if (effective.stt !== services.stt.provider) {
      updates.push({ path: "services.stt.provider", provider: effective.stt });
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

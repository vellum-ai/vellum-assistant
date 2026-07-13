/**
 * Managed-speech defaulting on Vellum connection.
 *
 * When the platform connection completes and a speech service has no working
 * BYOK credential, default that service to `mode: "managed"` so a fresh
 * Vellum connection gets voice features with zero configuration. A service
 * whose BYOK credential is already configured is never modified — connecting
 * Vellum must not silently reroute an existing voice setup — and a service
 * already in managed mode is left alone.
 */

import { ttsSecretResolves } from "../calls/telephony-tts-capability.js";
import { managedSpeechAvailable } from "../platform/managed-speech.js";
import { getProviderEntry } from "../providers/speech-to-text/provider-catalog.js";
import { sttProviderKeyResolves } from "../providers/speech-to-text/resolve.js";
import type { SttProviderId } from "../stt/types.js";
import { getCatalogProvider } from "../tts/provider-catalog.js";
import { getLogger } from "../util/logger.js";
import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "./loader.js";
import { effectiveTtsProvider } from "./schemas/tts.js";

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
 * Default unconfigured speech services to managed mode.
 *
 * Safe to call repeatedly (idempotent) and safe to fire-and-forget: it
 * no-ops unless the platform connection is fully usable, and it only ever
 * flips `mode` from `"your-own"` to `"managed"` for services with no
 * working BYOK credential.
 */
export async function maybeDefaultSpeechToManaged(): Promise<void> {
  try {
    if (!(await managedSpeechAvailable())) {
      return;
    }

    const services = getConfig().services;
    const updates: string[] = [];

    if (
      services.stt.mode !== "managed" &&
      !(await sttByokCredentialResolves(services.stt.provider))
    ) {
      updates.push("services.stt.mode");
    }

    if (services.tts.mode !== "managed") {
      const byokProvider = effectiveTtsProvider({
        mode: "your-own",
        provider: services.tts.provider,
      });
      if (!(await ttsByokCredentialsResolve(byokProvider))) {
        updates.push("services.tts.mode");
      }
    }

    if (updates.length === 0) {
      return;
    }

    const raw = loadRawConfig();
    for (const path of updates) {
      setNestedValue(raw, path, "managed");
    }
    saveRawConfig(raw);
    invalidateConfigCache();
    log.info(
      { defaulted: updates },
      "Defaulted unconfigured speech services to managed mode after Vellum connection",
    );
  } catch (err) {
    // Convenience defaulting must never break credential storage.
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Managed speech defaulting failed (non-fatal)",
    );
  }
}

/**
 * Connection-state speech-mode defaulting.
 *
 * The default speech mode follows the platform connection: logged in ⇒
 * managed, logged out ⇒ BYOK (the schema default). An explicit
 * `services.stt.mode` / `services.tts.mode` key in the raw config always
 * wins — defaulting only ever fills an absent key, so a user's choice
 * (made via the settings tool or the Voice settings cards, both of which
 * persist `mode`) is never overridden, in either direction.
 *
 * Runs at daemon startup and when the platform connection completes, so
 * bare-metal and Docker installs that were already logged in before this
 * defaulting existed converge on their next boot.
 */

import { managedSpeechAvailable } from "../platform/managed-speech.js";
import { getLogger } from "../util/logger.js";
import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "./loader.js";

const log = getLogger("managed-speech-defaults");

/** Read the raw (pre-schema) mode key for one speech service, if present. */
function rawMode(
  raw: Record<string, unknown>,
  service: "stt" | "tts",
): unknown {
  const services = raw.services;
  if (!services || typeof services !== "object") {
    return undefined;
  }
  const entry = (services as Record<string, unknown>)[service];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return (entry as Record<string, unknown>).mode;
}

/**
 * Default speech services with no explicit mode to managed when the
 * platform connection is fully usable.
 *
 * Safe to call repeatedly (idempotent — once written, the mode key is
 * present and never touched again) and safe to fire-and-forget: it no-ops
 * entirely when logged out, leaving the schema's BYOK default in place.
 */
export async function maybeDefaultSpeechToManaged(): Promise<void> {
  try {
    if (!(await managedSpeechAvailable())) {
      return;
    }

    const raw = loadRawConfig();
    const updates: string[] = [];
    if (rawMode(raw, "stt") === undefined) {
      updates.push("services.stt.mode");
    }
    if (rawMode(raw, "tts") === undefined) {
      updates.push("services.tts.mode");
    }
    if (updates.length === 0) {
      return;
    }

    for (const path of updates) {
      setNestedValue(raw, path, "managed");
    }
    // SttServiceSchema requires `provider` whenever the stt object exists, so
    // a sparse config would become invalid if we wrote `mode` alone.
    if (updates.includes("services.stt.mode")) {
      setNestedValue(
        raw,
        "services.stt.provider",
        getConfig().services.stt.provider,
      );
    }
    saveRawConfig(raw);
    invalidateConfigCache();
    log.info(
      { defaulted: updates },
      "Defaulted speech services to managed mode (platform connection present)",
    );
  } catch (err) {
    // Convenience defaulting must never break startup or credential storage.
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Managed speech defaulting failed (non-fatal)",
    );
  }
}

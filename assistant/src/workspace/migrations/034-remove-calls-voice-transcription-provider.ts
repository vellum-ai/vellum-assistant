import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Remove `calls.voice.transcriptionProvider` (and `calls.voice.speechModel`)
 * from persisted workspace configs, preserving user preferences by copying
 * them to `services.stt.provider` before deletion.
 *
 * Migration 033 backfilled `services.stt.provider` to `"deepgram"`
 * unconditionally. Users who had `calls.voice.transcriptionProvider: "Google"`
 * were silently switched to Deepgram STT. This migration corrects that by
 * reading the old value before removing it:
 *
 *   - If `calls.voice.transcriptionProvider` is `"Google"` and
 *     `services.stt.provider` is still `"deepgram"` (the 033 default),
 *     set `services.stt.provider` to `"google-gemini"`.
 *   - If `calls.voice.transcriptionProvider` is `"Deepgram"` or missing,
 *     no change needed.
 *   - If `calls.voice.speechModel` was set and the provider is being
 *     corrected to `"google-gemini"`, clear the speechModel since
 *     Deepgram-specific models (e.g. "nova-3") are not valid for Google.
 *
 * After copying, the migration removes `calls.voice.transcriptionProvider`
 * and `calls.voice.speechModel` from the persisted config.
 *
 * Idempotent: re-running the migration on an already-migrated config
 * produces no changes.
 */
export const removeCallsVoiceTranscriptionProviderMigration: WorkspaceMigration =
  {
    id: "034-remove-calls-voice-transcription-provider",
    description:
      "Copy calls.voice.transcriptionProvider to services.stt.provider and remove legacy keys",
    run(workspaceDir: string): void {
      const configPath = join(workspaceDir, "config.json");
      if (!existsSync(configPath)) return;

      let config: Record<string, unknown>;
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        config = raw as Record<string, unknown>;
      } catch {
        return; // Malformed JSON — skip
      }

      let changed = false;

      // ── Read legacy values ──────────────────────────────────────────────

      const calls = getObj(config, "calls");
      const voice = calls ? getObj(calls, "voice") : null;

      const legacyProvider =
        voice && typeof voice.transcriptionProvider === "string"
          ? voice.transcriptionProvider
          : null;

      // ── Copy preference to services.stt.provider if needed ─────────────

      if (legacyProvider === "Google") {
        const services = getObj(config, "services");
        const stt = services ? getObj(services, "stt") : null;

        if (stt && typeof stt.provider === "string") {
          // Only overwrite if it's still the migration 033 default
          if (stt.provider === "deepgram") {
            stt.provider = "google-gemini";
            changed = true;
          }
        }
      }

      // ── Remove legacy keys from calls.voice ────────────────────────────

      if (voice) {
        if ("transcriptionProvider" in voice) {
          delete voice.transcriptionProvider;
          changed = true;
        }
        if ("speechModel" in voice) {
          delete voice.speechModel;
          changed = true;
        }
      }

      // Only write when something actually changed
      if (changed) {
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      }
    },
    down(workspaceDir: string): void {
      // The down migration restores `calls.voice.transcriptionProvider`
      // from `services.stt.provider` where possible.
      const configPath = join(workspaceDir, "config.json");
      if (!existsSync(configPath)) return;

      let config: Record<string, unknown>;
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        config = raw as Record<string, unknown>;
      } catch {
        return;
      }

      const services = getObj(config, "services");
      const stt = services ? getObj(services, "stt") : null;
      const sttProvider =
        stt && typeof stt.provider === "string" ? stt.provider : null;

      // Reverse-map canonical provider ID to legacy enum value
      const legacyProvider = reverseMapProvider(sttProvider);

      if (!legacyProvider) return;

      const calls = ensureObj(config, "calls");
      const voice = ensureObj(calls, "voice");

      if (!("transcriptionProvider" in voice)) {
        voice.transcriptionProvider = legacyProvider;
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      }
    },
  };

// ---------------------------------------------------------------------------
// Helpers (self-contained per migration AGENTS.md)
// ---------------------------------------------------------------------------

/**
 * Safely get a nested object value. Returns null if the key is missing
 * or the value is not a plain object.
 */
function getObj(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const val = parent[key];
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}

/**
 * Ensure a nested key is an object. Creates it if missing or non-object.
 */
function ensureObj(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  if (
    !(key in parent) ||
    parent[key] == null ||
    typeof parent[key] !== "object" ||
    Array.isArray(parent[key])
  ) {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
}

/**
 * Map canonical `services.stt.provider` ID back to legacy
 * `calls.voice.transcriptionProvider` enum value for the down migration.
 */
function reverseMapProvider(sttProvider: string | null): string | null {
  if (!sttProvider) return null;
  switch (sttProvider) {
    case "deepgram":
      return "Deepgram";
    case "google-gemini":
      return "Google";
    default:
      return null;
  }
}

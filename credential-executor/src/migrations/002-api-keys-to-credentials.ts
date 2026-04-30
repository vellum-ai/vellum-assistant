import type { CesMigration } from "./types.js";

/**
 * Providers whose bare API-key entries (e.g. `anthropic`) must be moved to
 * the canonical `credential/{provider}/api_key` namespace.
 *
 * Note: `elevenlabs` is intentionally omitted — it was already migrated by
 * `migrateElevenLabsToCredential()` in the Swift layer before CES migrations
 * were introduced.
 */
const PROVIDERS_TO_MIGRATE = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
  "brave",
  "perplexity",
  "deepgram",
  "xai",
] as const;

export const apiKeyToCredentialsMigration: CesMigration = {
  id: "002-api-keys-to-credentials",
  description:
    "Rekey bare provider API keys to credential/{provider}/api_key namespace",

  async run(backend): Promise<void> {
    for (const provider of PROVIDERS_TO_MIGRATE) {
      const bareValue = await backend.get(provider);
      if (bareValue === undefined) continue; // nothing to migrate for this provider

      const credKey = `credential/${provider}/api_key`;
      const existingCred = await backend.get(credKey);
      if (existingCred === undefined) {
        // Write new key first — safe to re-run if we crash after this.
        // Throw on failure so the runner marks the migration failed and retries on next startup.
        const ok = await backend.set(credKey, bareValue);
        if (!ok) {
          throw new Error(
            `Migration 002: failed to write ${credKey} — aborting to preserve bare key ${provider}`,
          );
        }
      }
      // Always delete old bare key (idempotent: harmless if already absent)
      await backend.delete(provider);
    }
  },

  async down(backend): Promise<void> {
    for (const provider of PROVIDERS_TO_MIGRATE) {
      const credKey = `credential/${provider}/api_key`;
      const credValue = await backend.get(credKey);
      if (credValue === undefined) continue;

      const existingBare = await backend.get(provider);
      if (existingBare === undefined) {
        const ok = await backend.set(provider, credValue);
        if (!ok) {
          throw new Error(
            `Migration 002 rollback: failed to restore bare key ${provider} — preserving ${credKey}`,
          );
        }
      }
      await backend.delete(credKey);
    }
  },
};

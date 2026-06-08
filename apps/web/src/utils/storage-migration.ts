/**
 * One-time localStorage key migrations.
 *
 * All app-owned localStorage keys must start with either:
 * - `vellum:` — user-scoped, cleared on logout
 * - `device:` — device-scoped, preserved across sessions
 *
 * This module renames legacy keys (unprefixed, `onboarding.`, `voice:`,
 * `ff:client:`, `gw:`, `local:`, `integrations.`, `vellum_`) to the
 * canonical `vellum:` namespace so that session-cleanup.ts can use a
 * single prefix check instead of a brittle allowlist.
 *
 * Migrations are idempotent — safe to re-run on every app startup.
 * Executed synchronously at import time via `run-storage-migrations.ts`,
 * which must be imported before any Zustand store that reads localStorage
 * at module level (see the import order comment in `main.tsx`).
 */

/**
 * Migrate a key's stored value from one format to another without
 * renaming the key. Idempotent — only writes when the current value
 * matches `oldValue` exactly.
 */
export function migrateValue(key: string, oldValue: string, newValue: string): void {
  if (typeof window === "undefined") return;
  try {
    if (localStorage.getItem(key) === oldValue) {
      localStorage.setItem(key, newValue);
    }
  } catch {
    // Storage unavailable — retry on next load.
  }
}

/**
 * Remove a legacy key that has no successor. Idempotent.
 */
export function removeKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage unavailable — retry on next load.
  }
}

/**
 * Migrate a single static key. Idempotent: writes the new key only
 * when it doesn't already exist, removes the old key only after the
 * new key is confirmed persisted (guards against QuotaExceededError
 * silently losing the value).
 */
export function migrateKey(oldKey: string, newKey: string): void {
  if (typeof window === "undefined") return;
  try {
    const value = localStorage.getItem(oldKey);
    if (value === null) return;
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, value);
    }
    if (localStorage.getItem(newKey) !== null) {
      localStorage.removeItem(oldKey);
    }
  } catch {
    // Storage unavailable — migration retries on next load.
  }
}

/**
 * Migrate all keys matching `oldPrefix` to `newPrefix`, preserving
 * the suffix. Uses a snapshot of keys to avoid mutating during
 * iteration.
 */
export function migratePrefix(oldPrefix: string, newPrefix: string): void {
  if (typeof window === "undefined") return;
  try {
    const pairs: [string, string][] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(oldPrefix)) {
        const suffix = key.slice(oldPrefix.length);
        pairs.push([key, newPrefix + suffix]);
      }
    }
    for (const [oldKey, newKey] of pairs) {
      migrateKey(oldKey, newKey);
    }
  } catch {
    // Storage unavailable.
  }
}

/**
 * Run all pending storage key migrations. Called from
 * `run-storage-migrations.ts` (side-effect import at the top of
 * `main.tsx`), after `migrateDeviceSettings()` — device keys must
 * already be in the `device:` namespace before we migrate user keys.
 *
 * Each migration is a one-time rename: read old → write new → remove old.
 * The order within each group doesn't matter since there are no
 * inter-key dependencies.
 */
export function runStorageMigrations(): void {
  if (typeof window === "undefined") return;

  // -- Static key renames ------------------------------------------------

  // Unprefixed → vellum: (these escaped cleanup entirely before)
  migrateKey("assistantSidebarCollapsed", "vellum:sidebar:collapsed");
  migrateKey("assistantSidebarWidth", "vellum:sidebar:width");

  // voice: → vellum:voice:
  migrateKey("voice:permissionPrimerSeen", "vellum:voice:permissionPrimerSeen");
  migrateKey("voice:conversationTimeoutSeconds", "vellum:voice:conversationTimeoutSeconds");
  migrateKey("voice:ttsProvider", "vellum:voice:ttsProvider");
  migrateKey("voice:sttProvider", "vellum:voice:sttProvider");
  migrateKey("voice:activationKey", "vellum:voice:activationKey");

  // integrations. → vellum:integrations:
  migrateKey("integrations.bannerDismissed", "vellum:integrations:bannerDismissed");

  // onboarding. → vellum:onboarding:
  migrateKey("onboarding.tosAccepted", "vellum:onboarding:tosAccepted");
  migrateKey("onboarding.aiDataConsent", "vellum:onboarding:aiDataConsent");
  removeKey("onboarding.completed");
  removeKey("vellum:onboarding:completed");
  migrateKey("onboarding.selectedVersion", "vellum:onboarding:selectedVersion");

  // vellum:skillsTabTipDismissed → vellum:skills:tipDismissed (consistent naming)
  migrateKey("vellum:skillsTabTipDismissed", "vellum:skills:tipDismissed");

  // vellum_ → vellum:ai: (AI settings page)
  migrateKey("vellum_image_gen_mode", "vellum:ai:imageGenMode");
  migrateKey("vellum_image_gen_model", "vellum:ai:imageGenModel");
  migrateKey("vellum_web_search_mode", "vellum:ai:webSearchMode");
  migrateKey("vellum_web_search_provider", "vellum:ai:webSearchProvider");
  migrateKey("vellum_email_mode", "vellum:ai:emailMode");
  migrateKey("vellum_email_byo_provider", "vellum:ai:emailByoProvider");
  migrateKey("vellum_gemini_key", "vellum:ai:geminiKey");
  migrateKey("vellum_perplexity_key", "vellum:ai:perplexityKey");
  migrateKey("vellum_brave_key", "vellum:ai:braveKey");
  migrateKey("vellum_tavily_key", "vellum:ai:tavilyKey");

  // vellumDebug. → vellum:debug:
  migrateKey(
    "vellumDebug.flags.impersonateAssistantVersion",
    "vellum:debug:impersonateAssistantVersion",
  );

  // gw: → vellum:gw:
  migrateKey("gw:token", "vellum:gw:token");
  migrateKey("gw:expiresAt", "vellum:gw:expiresAt");
  migrateKey("gw:tokenSource", "vellum:gw:tokenSource");

  // local: → vellum:local:
  migrateKey("local:lockfile", "vellum:local:lockfile");
  migrateKey("local:selectedAssistantId", "vellum:local:selectedAssistantId");

  // -- Prefix renames (dynamic/per-entity keys) --------------------------

  // voice: per-provider keys → vellum:voice:
  migratePrefix("voice:ttsApiKey:", "vellum:voice:ttsApiKey:");
  migratePrefix("voice:ttsVoiceId:", "vellum:voice:ttsVoiceId:");
  migratePrefix("voice:sttApiKey:", "vellum:voice:sttApiKey:");

  // ff:client: → vellum:ff:
  migratePrefix("ff:client:", "vellum:ff:");

  // Unprefixed per-entity → vellum:
  migratePrefix("disk-pressure-warning-dismissed-", "vellum:diskPressureDismissed:");

  // vellum_ per-org → vellum:
  migratePrefix("vellum_current_assistant_id__", "vellum:currentAssistantId:");

  // -- Value format migrations ---------------------------------------------
  // Skills tip was stored as "1"; getLocalBool expects "true".
  migrateValue("vellum:skills:tipDismissed", "1", "true");

  // -- Dead key removals --------------------------------------------------
  // Legacy nudge keys superseded by the `vellum:nudge-prefs` Zustand
  // persist store. Also remove the one-time cleanup flag itself.
  removeKey("app.githubNudge.starred");
  removeKey("app.githubNudge.bannerDismissed");
  removeKey("app.githubNudge.bannerDismissedAt");
  removeKey("app.discordNudge.joined");
  removeKey("app.discordNudge.bannerDismissed");
  removeKey("app.discordNudge.firstSeenAt");
  removeKey("app.nudgeLegacy.cleaned");
}

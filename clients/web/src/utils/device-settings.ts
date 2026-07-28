/**
 * Typed registry and accessors for device-scoped localStorage settings.
 *
 * Device-level settings survive logout — they describe the physical
 * device's preferences, not a user account. The `device:` key prefix
 * makes this intent explicit and enables zero-maintenance cleanup in
 * session-cleanup.ts: any key starting with `device:` is automatically
 * preserved, everything else matching app prefixes is cleared.
 *
 * To add a new device setting:
 * 1. Add an entry to DEVICE_SETTINGS below
 * 2. Use getDeviceSetting / setDeviceSetting in your component
 * No cleanup list to update, no separate file to maintain.
 *
 * References:
 * - docs/STATE_MANAGEMENT.md — Logout and device-scoped storage
 */

import {
  setLocalBool,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";

/** Prefix for all device-scoped localStorage keys. */
export const DEVICE_PREFIX = "device:";

/**
 * One device-scoped setting: its `device:`-prefixed key and, when it predates
 * the prefix migration, the legacy non-prefixed key it migrated from.
 */
interface DeviceSettingEntry {
  key: string;
  /** Non-prefixed key migrated from. Absent for settings born post-migration. */
  legacy?: string;
}

/**
 * Registry of device-scoped settings. Each entry maps a logical name
 * to its localStorage key and the legacy key it was migrated from.
 */
const DEVICE_SETTINGS = {
  theme: { key: "device:theme", legacy: "vellum_theme" },
  shareAnalytics: { key: "device:share_analytics", legacy: "vellum_share_analytics" },
  shareDiagnostics: { key: "device:share_diagnostics", legacy: "vellum_share_diagnostics" },
  // Effective Sentry reporting gate: tracks the saved diagnostics preference
  // with opt-out semantics — closes only for an explicit opt-out; absent reads
  // open once consent has hydrated. Decoupled from `shareDiagnostics` (the
  // saved preference) so consent-resolution paths can write it independently.
  // No legacy key — introduced after the migration cutover.
  diagnosticsReporting: { key: "device:diagnostics_reporting" },
  biometricEnabled: { key: "device:biometric_enabled", legacy: "vellum_biometric_enabled" },
  llmLogRetention: { key: "device:llm_log_retention", legacy: "vellum_llm_log_retention" },
  timezone: { key: "device:timezone", legacy: "vellum_timezone" },
  mediaEmbedsEnabled: { key: "device:media_embeds_enabled", legacy: "vellum_media_embeds_enabled" },
  mediaEmbedDomains: { key: "device:media_embed_domains", legacy: "vellum_media_embed_domains" },
  dockBadgesEnabled: { key: "device:dock_badges_enabled", legacy: "vellum_dock_badges_enabled" },
  lastUserId: { key: "device:last_user_id", legacy: "onboarding.lastUserId" },
} as const satisfies Record<string, DeviceSettingEntry>;

export type DeviceSettingName = keyof typeof DEVICE_SETTINGS;

/** Returns the `device:`-prefixed localStorage key for a setting. */
export function deviceKey(name: DeviceSettingName): string {
  return DEVICE_SETTINGS[name].key;
}

/** Read an entry's legacy value, or `null` when it has no legacy key. */
function readLegacy(entry: DeviceSettingEntry): string | null {
  return entry.legacy != null ? localStorage.getItem(entry.legacy) : null;
}

/** Read a device-scoped setting, returning `fallback` when absent or unreadable. */
export function getDeviceSetting(name: DeviceSettingName, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const entry = DEVICE_SETTINGS[name];
  try {
    return localStorage.getItem(entry.key)
      ?? readLegacy(entry)
      ?? fallback;
  } catch {
    return fallback;
  }
}

/** Write a device-scoped setting. Fires the `vellum:pref-changed` event for same-tab observers. */
export function setDeviceSetting(name: DeviceSettingName, value: string): void {
  setLocalSetting(DEVICE_SETTINGS[name].key, value);
}

/** Read a boolean device setting. */
export function getDeviceBool(name: DeviceSettingName, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const entry = DEVICE_SETTINGS[name];
  try {
    const raw = localStorage.getItem(entry.key)
      ?? readLegacy(entry);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // Storage unavailable
  }
  return fallback;
}

/** Write a boolean device setting. */
export function setDeviceBool(name: DeviceSettingName, value: boolean): void {
  setLocalBool(DEVICE_SETTINGS[name].key, value);
}

/**
 * Watch a device setting for changes (cross-tab and same-tab).
 * Returns a cleanup function that removes both listeners.
 */
export function watchDeviceSetting(
  name: DeviceSettingName,
  callback: () => void,
): () => void {
  return watchSetting(DEVICE_SETTINGS[name].key, callback);
}

/**
 * One-time migration: reads values from legacy (non-prefixed) keys,
 * writes them to the new `device:`-prefixed keys, and removes the
 * legacy keys. Idempotent — safe to re-run on every app startup.
 *
 * Uses `setLocalSetting` (not raw `localStorage.setItem`) so the
 * `vellum:pref-changed` custom event fires for each migrated key.
 * Same-tab observers (Sentry consent gate, onboarding store) pick
 * up the new values without needing a full page reload.
 */
export function migrateDeviceSettings(): void {
  if (typeof window === "undefined") return;
  try {
    for (const entry of Object.values<DeviceSettingEntry>(DEVICE_SETTINGS)) {
      if (entry.legacy == null) continue;
      const legacyValue = localStorage.getItem(entry.legacy);
      if (legacyValue !== null) {
        // Only write if the new key doesn't already exist — avoids
        // overwriting a value that was set by new code between loads.
        if (localStorage.getItem(entry.key) === null) {
          setLocalSetting(entry.key, legacyValue);
        }
        // Only remove the legacy key if the new key was persisted.
        // setLocalSetting swallows QuotaExceededError, so without
        // this guard a failed write would delete the legacy key and
        // lose the user's preference.
        if (localStorage.getItem(entry.key) !== null) {
          localStorage.removeItem(entry.legacy);
        }
      }
    }
  } catch {
    // Storage unavailable — migration will retry on next load.
  }
}

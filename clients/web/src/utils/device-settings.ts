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

/** One device-scoped setting: its `device:`-prefixed localStorage key. */
interface DeviceSettingEntry {
  key: string;
}

/**
 * Registry of device-scoped settings. Each entry maps a logical name
 * to its localStorage key.
 */
const DEVICE_SETTINGS = {
  theme: { key: "device:theme" },
  shareAnalytics: { key: "device:share_analytics" },
  shareDiagnostics: { key: "device:share_diagnostics" },
  // Effective Sentry reporting gate: tracks the saved diagnostics preference
  // with opt-out semantics, closing only for an explicit opt-out; absent reads
  // open once consent has hydrated. Decoupled from `shareDiagnostics` (the
  // saved preference) so consent-resolution paths can write it independently.
  diagnosticsReporting: { key: "device:diagnostics_reporting" },
  biometricEnabled: { key: "device:biometric_enabled" },
  llmLogRetention: { key: "device:llm_log_retention" },
  timezone: { key: "device:timezone" },
  // UI language, as a tag from `SUPPORTED_LOCALES`. Absent means "follow the
  // host's preferred languages"; a value here is an explicit user override and
  // outranks the host. Device-scoped so it survives logout: the login screen
  // must stay in the language the user picked.
  locale: { key: "device:locale" },
  mediaEmbedsEnabled: { key: "device:media_embeds_enabled" },
  mediaEmbedDomains: { key: "device:media_embed_domains" },
  dockBadgesEnabled: { key: "device:dock_badges_enabled" },
  lastUserId: { key: "device:last_user_id" },
  // Allowlisted attribution parsed out of the Android Play install referrer,
  // stored as a query string. Describes the install, so it outlives any
  // account that signs in on this device.
  installReferrer: { key: "device:install_referrer" },
} as const satisfies Record<string, DeviceSettingEntry>;

export type DeviceSettingName = keyof typeof DEVICE_SETTINGS;

/** Returns the `device:`-prefixed localStorage key for a setting. */
export function deviceKey(name: DeviceSettingName): string {
  return DEVICE_SETTINGS[name].key;
}

/** Read a device-scoped setting, returning `fallback` when absent or unreadable. */
export function getDeviceSetting(
  name: DeviceSettingName,
  fallback: string,
): string {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    return localStorage.getItem(DEVICE_SETTINGS[name].key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Write a device-scoped setting. Fires the `vellum:pref-changed` event for same-tab observers. */
export function setDeviceSetting(name: DeviceSettingName, value: string): void {
  setLocalSetting(DEVICE_SETTINGS[name].key, value);
}

/** Whether a device-scoped setting is stored at all, an empty value included. */
export function hasDeviceSetting(name: DeviceSettingName): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return localStorage.getItem(DEVICE_SETTINGS[name].key) !== null;
  } catch {
    return false;
  }
}

/** Read a boolean device setting. */
export function getDeviceBool(
  name: DeviceSettingName,
  fallback: boolean,
): boolean {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = localStorage.getItem(DEVICE_SETTINGS[name].key);
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
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

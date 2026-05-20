/**
 * Shared localStorage helpers for platform-specific app-nudge modules.
 *
 * Both `mac-app-nudge/prefs.ts` and `ios-app-nudge/prefs.ts` use these
 * to read/write boolean and number preferences. Extracting them avoids
 * duplicating identical helpers across nudge modules.
 */

import {
  getLocalSetting,
  setLocalSetting,
} from "@/domains/settings/local-settings.js";

export function readBooleanPref(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = getLocalSetting(key, String(defaultValue));
    if (raw === "true") return true;
    if (raw === "false") return false;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

export function writeBooleanPref(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    setLocalSetting(key, value ? "true" : "false");
  } catch {
    // Storage unavailable — degrade gracefully.
  }
}

export function readNumberPref(key: string, defaultValue: number): number {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = getLocalSetting(key, String(defaultValue));
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function writeNumberPref(key: string, value: number): void {
  if (typeof window === "undefined") return;
  try {
    setLocalSetting(key, String(value));
  } catch {
    // Storage unavailable — degrade gracefully.
  }
}

/**
 * Cascade gate shared by every app-nudge module. The sidebar entry is
 * the second surface a user sees after the in-chat banner; it should
 * only appear once the banner is no longer eligible to render — either
 * because the user converted (clicked the CTA → `converted = true`)
 * or because the user dismissed the banner (`bannerDismissed = true`).
 *
 * The user can then dismiss the sidebar entry independently
 * (`sidebarDismissed = true`), at which point the only remaining
 * surface is the always-visible Settings card.
 *
 * Without this cascade, the banner and sidebar render simultaneously
 * the moment they become eligible, which double-prompts the user.
 */
export function computeNudgeSidebarVisible(args: {
  converted: boolean;
  bannerDismissed: boolean;
  sidebarDismissed: boolean;
}): boolean {
  if (args.converted) return false;
  if (args.sidebarDismissed) return false;
  return args.bannerDismissed;
}

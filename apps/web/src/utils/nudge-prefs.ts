/**
 * Shared localStorage helpers for platform-specific app-nudge modules.
 *
 * Both `use-ios-app-nudge.ts` and `use-macos-app-nudge.ts` use these
 * to read/write boolean and number preferences. Extracting them avoids
 * duplicating identical helpers across nudge modules.
 */

import {
  getLocalSetting,
  setLocalSetting,
} from "@/lib/local-settings.js";

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

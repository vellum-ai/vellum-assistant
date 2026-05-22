/**
 * Applies the user's stored theme preference on mount and keeps
 * the document in sync when the OS-level `prefers-color-scheme`
 * changes.
 *
 * Call this once from the root layout so theme is applied before
 * any child UI paints.
 */
import { useEffect } from "react";

import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store.js";
import {
  applyThemePreference,
  normalizeThemePreference,
  THEME_STORAGE_KEY,
} from "@/domains/settings/utils/theme-preferences.js";

function readRawStoredTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function useAppTheme() {
  const velvet = useClientFeatureFlagStore.use.velvet();

  useEffect(() => {
    const stored = readRawStoredTheme();
    const theme = normalizeThemePreference(stored, {
      velvetEnabled: velvet,
    });

    applyThemePreference(theme);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleMediaChange = () => {
      const next = normalizeThemePreference(readRawStoredTheme(), {
        velvetEnabled: velvet,
      });
      if (next === "system") {
        applyThemePreference(next);
      }
    };

    mediaQuery.addEventListener("change", handleMediaChange);
    return () => mediaQuery.removeEventListener("change", handleMediaChange);
  }, [velvet]);
}

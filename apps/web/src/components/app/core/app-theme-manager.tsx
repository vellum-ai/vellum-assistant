
import { useEffect } from "react";

import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";
import {
  applyThemePreference,
  normalizeThemePreference,
  THEME_STORAGE_KEY,
  writeStoredThemePreference,
} from "@/lib/theme-preferences.js";

function readRawStoredTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function AppThemeManager() {
  const { velvet } = useAppFeatureFlags();

  useEffect(() => {
    const stored = readRawStoredTheme();
    const theme = normalizeThemePreference(stored, {
      velvetEnabled: velvet,
    });

    if (stored !== null && stored !== theme) {
      writeStoredThemePreference(theme);
    }
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

  return null;
}

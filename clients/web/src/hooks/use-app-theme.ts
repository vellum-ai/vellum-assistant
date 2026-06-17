/**
 * Applies the user's stored theme preference on mount and keeps
 * the document in sync when the OS-level `prefers-color-scheme`
 * changes.
 *
 * Call this once from the root layout so theme is applied before
 * any child UI paints.
 */
import { useEffect } from "react";

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import {
  applyThemePreference,
  readStoredThemePreference,
} from "@/domains/settings/utils/theme-preferences";

export function useAppTheme() {
  const velvet = useClientFeatureFlagStore.use.velvet();

  useEffect(() => {
    const theme = readStoredThemePreference({ velvetEnabled: velvet });
    applyThemePreference(theme);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleMediaChange = () => {
      const next = readStoredThemePreference({ velvetEnabled: velvet });
      if (next === "system") {
        applyThemePreference(next);
      }
    };

    mediaQuery.addEventListener("change", handleMediaChange);
    return () => mediaQuery.removeEventListener("change", handleMediaChange);
  }, [velvet]);
}

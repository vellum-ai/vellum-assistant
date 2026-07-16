import { useEffect, useState } from "react";

import {
  applyThemePreference,
  readStoredThemePreference,
  type ThemePreference,
  writeStoredThemePreference,
} from "@/utils/theme-preferences";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { watchDeviceSetting } from "@/utils/device-settings";

/**
 * Shared theme-preference state used by both the compact `ThemeToggle` in the
 * sidebar preferences popover and the `AppearanceCard` on Settings → General.
 * Keeps the two surfaces in sync (they read/write the same device setting)
 * without duplicating the effect chain.
 *
 * @returns the current theme and a setter that persists + applies the choice.
 */
export function useThemePreference() {
  const velvet = useClientFeatureFlagStore.use.velvet();
  const [theme, setTheme] = useState<ThemePreference>(() =>
    readStoredThemePreference({ velvetEnabled: velvet }),
  );

  useEffect(() => {
    setTheme(readStoredThemePreference({ velvetEnabled: velvet }));
  }, [velvet]);

  useEffect(() => {
    return watchDeviceSetting("theme", () => {
      setTheme(readStoredThemePreference({ velvetEnabled: velvet }));
    });
  }, [velvet]);

  useEffect(() => {
    applyThemePreference(theme);
  }, [theme]);

  const setThemePreference = (next: ThemePreference) => {
    setTheme(next);
    writeStoredThemePreference(next);
  };

  return { theme, setThemePreference } as const;
}

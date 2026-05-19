
import { useEffect } from "react";

import {
  applyThemePreference,
  getEffectiveThemePreference,
  readStoredThemePreference,
  writeStoredThemePreference,
} from "@/lib/theme-preferences.js";

/**
 * Registers a global Cmd+Alt+T (Mac) / Ctrl+Alt+T (Windows/Linux) keyboard
 * shortcut that toggles the site theme between dark and light.
 */
export function ThemeShortcut() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // On Mac, Option+T produces "†" for event.key — use event.code so the
      // shortcut fires regardless of the modified character.
      const isShortcut =
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        !event.shiftKey &&
        event.code === "KeyT";
      if (!isShortcut) return;

      event.preventDefault();

      const stored = readStoredThemePreference({ velvetEnabled: false });
      const effectiveTheme = getEffectiveThemePreference(stored);
      const nextTheme = effectiveTheme === "dark" ? "light" : "dark";

      writeStoredThemePreference(nextTheme);
      applyThemePreference(nextTheme);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return null;
}

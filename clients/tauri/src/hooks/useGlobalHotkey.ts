/**
 * Cmd+Option+Space toggles the HUD window. We register through the Tauri
 * global-shortcut plugin so the binding works even when the WebView is
 * unfocused.
 */

import {
  isRegistered,
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { useEffect } from "react";

const DEFAULT_ACCELERATOR = "CmdOrControl+Alt+Space";

export function useGlobalHotkey(
  accelerator: string,
  onTrigger: () => void,
): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!(await isRegistered(accelerator))) {
          await register(accelerator, () => {
            if (!cancelled) onTrigger();
          });
        }
      } catch {
        // Ignore — the binding is best-effort. If another app owns the
        // accelerator we silently fall back to tray-only activation.
      }
    })();
    return () => {
      cancelled = true;
      void unregister(accelerator).catch(() => {
        /* best effort */
      });
    };
  }, [accelerator, onTrigger]);
}

export const ELI_DEFAULT_HOTKEY = DEFAULT_ACCELERATOR;

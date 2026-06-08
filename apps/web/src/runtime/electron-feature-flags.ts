import { useEffect } from "react";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import {
  ASSISTANT_FLAG_DEFAULTS,
  storeKeyToFlagKey,
} from "@/lib/feature-flags/feature-flag-catalog";
import { isElectron } from "@/runtime/is-electron";

/**
 * Syncs assistant feature flags from the renderer's Zustand store to the
 * Electron main process's `electron-store` (via `window.vellum.featureFlags`).
 *
 * The main process (tray menu, dock, global shortcuts) cannot directly
 * access the renderer's Zustand state. This bridge ensures that any flag
 * gating in main-process code (e.g. the assistant-switcher submenu) stays
 * in sync with the daemon-served flag values.
 *
 * No-op on non-Electron hosts.
 */
function writeToMainProcess(): void {
  const state = useAssistantFeatureFlagStore.getState();
  const flags: Record<string, boolean> = {};

  for (const storeKey of Object.keys(ASSISTANT_FLAG_DEFAULTS)) {
    const value = state[storeKey];
    if (typeof value !== "boolean") {
      continue;
    }
    const flagKey = storeKeyToFlagKey(storeKey);
    if (flagKey) {
      flags[flagKey] = value;
    }
  }

  window.vellum?.featureFlags?.set(flags);
}

/**
 * React hook that subscribes to the assistant feature flag store and syncs
 * boolean flags to the Electron main process on every change. Mount once
 * in `RootLayout`.
 *
 * No-op on non-Electron hosts.
 */
export function useElectronFeatureFlagBridge(): void {
  useEffect(() => {
    if (!isElectron()) {
      return;
    }

    // Initial sync on mount.
    writeToMainProcess();

    // Re-sync on every store update.
    const unsub = useAssistantFeatureFlagStore.subscribe(writeToMainProcess);
    return unsub;
  }, []);
}

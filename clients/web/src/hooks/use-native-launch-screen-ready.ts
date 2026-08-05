import { useEffect } from "react";

import { markNativeLaunchScreenReady } from "@/runtime/native-launch-screen";
import { readStoredThemePreference } from "@/utils/theme-preferences";

/** Releases the Android launch screen after the first React tree commits. */
export function useNativeLaunchScreenReady(): void {
  useEffect(() => {
    void markNativeLaunchScreenReady(
      readStoredThemePreference({ velvetEnabled: true }),
    );
  }, []);
}

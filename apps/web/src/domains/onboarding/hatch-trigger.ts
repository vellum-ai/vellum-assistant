/**
 * Shared hatch-operation state between the privacy screen (trigger) and the
 * hatching screen (progress monitor).
 *
 * The privacy screen fires the hatch on "Start" click and navigates to the
 * hatching screen, which picks up the in-flight promise and handles the
 * post-hatch setup (gateway readiness, provider key, avatar sync). This
 * avoids useEffect-driven hatch triggers that re-fire on dependency changes.
 *
 * Module-level state so it survives the unmount/remount across navigation
 * and React strict-mode double mounts.
 */

import { hatchLocalAssistant, type LocalHatchResult } from "@/runtime/local-mode-host";
import { hatchAssistant, type HatchResult } from "@/assistant/api";
import { readSelectedVersion } from "@/domains/onboarding/prefs";

let localHatchPromise: Promise<LocalHatchResult> | null = null;
let platformHatchPromise: Promise<HatchResult> | null = null;

export function triggerLocalHatch(species = "vellum", remote?: string): Promise<LocalHatchResult> {
  if (!localHatchPromise) {
    localHatchPromise = hatchLocalAssistant(species, remote);
  }
  return localHatchPromise;
}

export function triggerPlatformHatch(): Promise<HatchResult> {
  if (!platformHatchPromise) {
    const pinnedVersion = readSelectedVersion();
    platformHatchPromise = hatchAssistant(
      pinnedVersion ? { version: pinnedVersion } : undefined,
    );
  }
  return platformHatchPromise;
}

export function getLocalHatchPromise(): Promise<LocalHatchResult> | null {
  return localHatchPromise;
}

export function getPlatformHatchPromise(): Promise<HatchResult> | null {
  return platformHatchPromise;
}

export function clearLocalHatch(): void {
  localHatchPromise = null;
}

export function clearPlatformHatch(): void {
  platformHatchPromise = null;
}

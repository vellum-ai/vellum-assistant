import { useCallback, useSyncExternalStore } from "react";

import {
  getLocalSetting,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";
import { LS_FEATURE_INTRO_SEEN_PREFIX } from "@/utils/local-settings-keys";

/**
 * Every feature that announces itself with a one-time intro modal. Adding an
 * intro means adding its id here; the id is the storage key's tail, so it is
 * never renamed once shipped or the intro shows a second time.
 */
export type FeatureIntroId = "assistant-email";

function keyFor(id: FeatureIntroId): string {
  return `${LS_FEATURE_INTRO_SEEN_PREFIX}${id}`;
}

/** Whether the intro has been dismissed on this device. */
export function readFeatureIntroSeen(id: FeatureIntroId): boolean {
  return getLocalSetting(keyFor(id), "0") === "1";
}

/** Record that the intro has been dismissed on this device. */
export function markFeatureIntroSeen(id: FeatureIntroId): void {
  setLocalSetting(keyFor(id), "1");
}

export interface FeatureIntroSeen {
  /** The intro has been dismissed on this device; it never shows again. */
  seen: boolean;
  markSeen: () => void;
}

/**
 * The one-time intro pattern's memory: a feature's intro modal shows on the
 * first open of the app after the feature lands, and once dismissed, by any
 * route out of it, never again on this device. Kept on the device rather
 * than the platform so the intro costs no request and works before any
 * account data has arrived. Subscribed, so every mount of the gate agrees
 * the moment one of them records the dismissal.
 */
export function useFeatureIntroSeen(id: FeatureIntroId): FeatureIntroSeen {
  const key = keyFor(id);
  const subscribe = useCallback(
    (onChange: () => void) => watchSetting(key, onChange),
    [key],
  );
  const seen = useSyncExternalStore(
    subscribe,
    () => readFeatureIntroSeen(id),
    // Unknown until the device can be asked; the gate treats it as seen so
    // nothing flashes over a server render.
    () => true,
  );
  const markSeen = useCallback(() => markFeatureIntroSeen(id), [id]);
  return { seen, markSeen };
}

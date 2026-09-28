import { useCallback, useSyncExternalStore } from "react";

import {
  getLocalSetting,
  notifySettingChange,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";
import { LS_FEATURE_INTRO_SEEN_PREFIX } from "@/utils/local-settings-keys";

/**
 * Every feature that announces itself with a one-time intro modal. Adding an
 * intro means adding its id here and its launch in
 * {@link FEATURE_INTRO_LAUNCHED_AT}; the id is the storage key's tail, so it
 * is never renamed once shipped or the intro shows a second time.
 */
export type FeatureIntroId = "assistant-email";

/**
 * When each intro shipped, as an ISO instant. An intro is news only to a
 * user who was here before it: an account made after the launch meets the
 * feature as part of the app, in its own surfaces, and is never shown the
 * announcement. See {@link predatesFeatureIntro}.
 */
export const FEATURE_INTRO_LAUNCHED_AT: Record<FeatureIntroId, string> = {
  "assistant-email": "2026-09-29T00:00:00Z",
};

/**
 * Whether an account made at `createdAt` (an ISO instant) was here before
 * the intro shipped, and so is owed it. Unknown or unparseable is `false`:
 * an intro is withheld rather than shown to someone it is not for.
 */
export function predatesFeatureIntro(
  createdAt: string | null | undefined,
  id: FeatureIntroId,
): boolean {
  if (!createdAt) {
    return false;
  }
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) {
    return false;
  }
  return created < Date.parse(FEATURE_INTRO_LAUNCHED_AT[id]);
}

function keyFor(id: FeatureIntroId): string {
  return `${LS_FEATURE_INTRO_SEEN_PREFIX}${id}`;
}

/**
 * Dismissals that did not reach storage (private browsing, quota, storage
 * disabled by policy). Held here so the modal still closes for that user;
 * it returns on their next visit, which is the best a device with no
 * memory can do.
 */
const unpersisted = new Set<FeatureIntroId>();

/** Whether the intro has been dismissed on this device. */
export function readFeatureIntroSeen(id: FeatureIntroId): boolean {
  return getLocalSetting(keyFor(id), "0") === "1" || unpersisted.has(id);
}

/** Record that the intro has been dismissed on this device. */
export function markFeatureIntroSeen(id: FeatureIntroId): void {
  const key = keyFor(id);
  if (setLocalSetting(key, "1")) {
    unpersisted.delete(id);
    return;
  }
  // The write was refused, so nothing announced it; say so ourselves, or a
  // subscriber keeps reading the intro as owed and the modal never closes.
  unpersisted.add(id);
  notifySettingChange(key, "1");
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

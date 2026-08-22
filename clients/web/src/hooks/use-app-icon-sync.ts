/**
 * Reconciles the iOS home-screen icon with the assistant's avatar.
 *
 * The hook only ever *offers*. iOS shows a system alert the app cannot
 * suppress on every icon swap, so `apply` and `reset` are the two functions in
 * this repo allowed to reach `setAppIcon`, and both are bound to an explicit
 * user tap (the match prompt's Apply, the settings card's Match / Reset).
 * Nothing here fires on its own.
 *
 * Every name comes from `appIconNameForAvatar` through
 * {@link resolveAppIconTarget}, so an uploaded image, an AI-generated avatar,
 * or no avatar at all resolves to `null` and can never be offered.
 *
 * The whole surface reports `enabled: false`, and therefore draws nothing, off
 * native iOS, with the `ios-avatar-app-icon` flag off, or when the installed
 * shell answers `supported: false` (`docs/CAPACITOR.md` § The skew rule).
 * A shell that supports alternates but bundles none this avatar maps to stays
 * enabled: {@link resolveAppIconTarget} reports no match, so `canOffer` is
 * false and nothing is ever offered, while the settings card still has a real
 * status to report.
 *
 * The shell's answer is one fact about one device, so it lives in
 * {@link useAppIconStore} rather than in per-instance state: an apply from the
 * root prompt has to reach the settings card mounted beside it.
 */
import { useCallback, useEffect } from "react";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { getAppIconState, setAppIcon } from "@/runtime/app-icon";
import { useIsNativeIOS } from "@/runtime/platform-detection";
import { APP_ICON_UNSUPPORTED, useAppIconStore } from "@/stores/app-icon-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { resolveAppIconTarget } from "@/utils/avatar-app-icon";

export interface AppIconSync {
  /** Whether any app-icon UI may draw at all. */
  enabled: boolean;
  /** The alternate icon currently applied, or null for the default icon. */
  currentIcon: string | null;
  /** The icon this avatar maps to, or null when it maps to none. */
  targetIcon: string | null;
  /** True when the shell bundles `targetIcon` and it is not already applied. */
  canOffer: boolean;
  /**
   * Apply `targetIcon`. User-initiated only. Resolves true only when a re-read
   * of the shell finds the icon on the home screen, so callers can keep their
   * action on screen.
   */
  apply: () => Promise<boolean>;
  /** Restore the default icon. User-initiated only. Resolves as `apply` does. */
  reset: () => Promise<boolean>;
}

export function useAppIconSync(assistantId: string | null): AppIconSync {
  const isNativeIOS = useIsNativeIOS();
  const flagEnabled = useClientFeatureFlagStore.use.iosAvatarAppIcon();
  const gateOpen = isNativeIOS && flagEnabled;

  const { state } = useAssistantAvatar(assistantId);
  const iconState = useAppIconStore.use.snapshot();
  const setSnapshot = useAppIconStore.use.setSnapshot();

  // Publishes the shell's answer and hands the same snapshot back, so a caller
  // that just asked for a swap can judge it against what the shell now reports.
  const refresh = useCallback(async () => {
    if (!gateOpen) {
      setSnapshot(APP_ICON_UNSUPPORTED);
      return APP_ICON_UNSUPPORTED;
    }
    const next = await getAppIconState();
    setSnapshot(next);
    return next;
  }, [gateOpen, setSnapshot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The user can put the default icon back from iOS Settings while the app is
  // backgrounded, so the snapshot taken at mount goes stale. Re-read the
  // shell's answer on every foreground rather than trusting it.
  useBusSubscription("app.resume", () => {
    void refresh();
  });

  const enabled = gateOpen && iconState.supported;
  const { target, availableMatch } = resolveAppIconTarget(state, iconState);
  const canOffer = availableMatch && target !== iconState.current;

  // iOS can refuse a swap outright, and it can also take one and leave the home
  // screen alone (the app backgrounded mid-swap, the iOS 26 regressions). The
  // request's own answer is therefore not evidence that anything changed, so
  // both callbacks re-read the shell and report what that read found. The
  // caller has UI riding on the answer, and it should be riding on the home
  // screen rather than on the request. A read that degrades, an old shell or a
  // bridge fault, cannot verify anything, so both callbacks report failure
  // instead of throwing.
  const apply = useCallback(async () => {
    if (!enabled || !availableMatch || target === null) {
      return false;
    }
    await setAppIcon(target);
    const applied = await refresh();
    return applied.supported && applied.current === target;
  }, [enabled, availableMatch, target, refresh]);

  const reset = useCallback(async () => {
    if (!enabled) {
      return false;
    }
    await setAppIcon(null);
    const restored = await refresh();
    return restored.supported && restored.current === null;
  }, [enabled, refresh]);

  return {
    enabled,
    currentIcon: enabled ? iconState.current : null,
    targetIcon: enabled ? target : null,
    canOffer,
    apply,
    reset,
  };
}

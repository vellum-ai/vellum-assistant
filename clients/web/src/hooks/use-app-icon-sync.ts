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
 * native iOS, with the `ios-avatar-app-icon` flag off, or on a shell whose
 * build ships no alternate icons (`docs/CAPACITOR.md` § The skew rule).
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
   * Apply `targetIcon`. User-initiated only. Resolves true only when the home
   * screen actually changed, so callers can keep their action on screen.
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

  const refresh = useCallback(async () => {
    if (!gateOpen) {
      setSnapshot(APP_ICON_UNSUPPORTED);
      return;
    }
    setSnapshot(await getAppIconState());
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

  // iOS can refuse a swap, and the caller has UI riding on the answer, so the
  // shell's verdict is handed back rather than swallowed. The refresh runs
  // either way: a refusal still has to leave the snapshot telling the truth
  // about what is on the home screen.
  const apply = useCallback(async () => {
    if (!enabled || !availableMatch || target === null) {
      return false;
    }
    const applied = await setAppIcon(target);
    await refresh();
    return applied;
  }, [enabled, availableMatch, target, refresh]);

  const reset = useCallback(async () => {
    if (!enabled) {
      return false;
    }
    const restored = await setAppIcon(null);
    await refresh();
    return restored;
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

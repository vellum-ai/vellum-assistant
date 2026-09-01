/**
 * Ties the frame gate's live options to whether this session may tune them.
 *
 * Two bits decide what the gate runs: the readout's persisted switch, and
 * whether this session is allowed the readout at all. Only their conjunction
 * reaches {@link syncFrameGateDebugOptions}, so a session that cannot see the
 * panel cannot be running the thresholds someone set through it. Without that,
 * a tuned gate looks like a broken camera: photos stop being taken, and the
 * only surface that would explain why is hidden.
 *
 * Losing access drops the applied overrides and leaves the persisted switch
 * and the slider values alone. Writing the switch off instead would erase the
 * preference on every launch, because access reads false during boot until the
 * session and the flags land.
 *
 * The watcher runs outside React. Both gates are built from `sight-store` and
 * `use-voice-room-sight` whenever a camera opens, whether or not anything that
 * reads `hooks/use-camera-gate-hud.ts` is mounted, so a component-scoped
 * effect would leave the record holding a tuned threshold for exactly the
 * sessions that have no panel on screen.
 */

import { isVellumStaff } from "@/lib/auth/staff";
import { syncFrameGateDebugOptions } from "@/lib/camera/frame-gate-debug";
import { useAuthStore, type AuthUser } from "@/stores/auth-store";
import { useCameraGateDebugStore } from "@/stores/camera-gate-debug-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * Whether a session may reach the readout.
 *
 * Two signals, and the flag is not redundant with the staff check. A local
 * gateway session has no platform identity and is never staff, and a local
 * session is exactly where the gate gets tuned: a developer with a webcam and
 * a dev server. The flag is what lets that session in without widening who
 * counts as staff.
 */
export function cameraGateHudAvailable(
  user: AuthUser | null,
  flagged: boolean,
): boolean {
  return isVellumStaff(user) || flagged;
}

/** The same answer read outside React, for the subscriptions below. */
function availableNow(): boolean {
  return cameraGateHudAvailable(
    useAuthStore.getState().user,
    useClientFeatureFlagStore.getState().cameraGateDebugHud === true,
  );
}

/**
 * Push the effective enable bit and the thresholds in hand at the gate.
 *
 * Every store write that can change either lands here, which keeps
 * {@link syncFrameGateDebugOptions} a single-writer seam: the record only ever
 * holds overrides a session both asked for and is allowed.
 */
function applyEffectiveOptions(): void {
  const { hudEnabled, overrides } = useCameraGateDebugStore.getState();
  syncFrameGateDebugOptions(availableNow() && hudEnabled, overrides);
}

/**
 * Call once at startup. Returns an unsubscribe for tests.
 *
 * The subscriptions carry no selector: the answer is a function of slices in
 * three stores, and a selectorless subscriber runs on every write to any of
 * them, including the persist middleware restoring a switch left on.
 */
export function setupCameraGateHudAccessSync(): () => void {
  applyEffectiveOptions();
  const unsubscribeAuth = useAuthStore.subscribe(applyEffectiveOptions);
  const unsubscribeFlags = useClientFeatureFlagStore.subscribe(
    applyEffectiveOptions,
  );
  const unsubscribeDebug = useCameraGateDebugStore.subscribe(
    applyEffectiveOptions,
  );
  return () => {
    unsubscribeAuth();
    unsubscribeFlags();
    unsubscribeDebug();
  };
}

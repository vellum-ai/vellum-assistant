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
 * The account is watched from here too. A tuning session belongs to whoever
 * ran it, so the preference is dropped when a different account signs in.
 * That is keyed on the account rather than on a session ending, because a
 * session can end without the logout sweep running and because the two can be
 * separated by a reload.
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
import {
  useCameraGateDebugStore,
  watchCameraGateDebugStorage,
} from "@/stores/camera-gate-debug-store";
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
 * Bind the stored preference to whoever is signed in now.
 *
 * A session can end without the logout sweep running: an expired or revoked
 * one is discovered by a probe and simply ends, which leaves the switch and
 * the thresholds behind for the next account to inherit. Reacting to the
 * account rather than to the ending covers both, and covers the reload in
 * between, because the store remembers whose preference it holds.
 *
 * A window with no user is not an account change. Boot before the session
 * resolves, a token refresh, and an expired session all sit in one, and
 * dropping the preference there would cost the user their tuning every launch
 * for no gain: with no identity there is no access, so the thresholds already
 * stop reaching the gate.
 */
function claimForCurrentUser(): void {
  const userId = useAuthStore.getState().user?.id ?? null;
  if (userId === null) {
    return;
  }
  useCameraGateDebugStore.getState().claimForUser(userId);
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

/** Settle ownership first, so the options applied are the current account's. */
function onAuthChange(): void {
  claimForCurrentUser();
  applyEffectiveOptions();
}

/**
 * Whether a payload another tab left is this tab's to read.
 *
 * Answered before anything is restored, because the alternative is a loop. A
 * foreign payload adopted here would be corrected by the claim, that
 * correction is a persisted write, and the tab that wrote the original reads
 * it and corrects it back: two signed-in accounts trading the key with nobody
 * touching a switch. Refusing to read it costs this tab nothing, since the
 * preference it is holding is already its own.
 *
 * A payload naming no owner is accepted: nothing has claimed it, so there is
 * no account to disagree with, and the claim that follows the restore is what
 * binds it. A window with no user resolved yet accepts nothing owned, which is
 * the same caution {@link claimForCurrentUser} takes for the same reason: boot
 * and a token refresh both look like a signed-out window.
 */
function ownsPersistedPreference(ownerUserId: string | null): boolean {
  if (ownerUserId === null) {
    return true;
  }
  return ownerUserId === (useAuthStore.getState().user?.id ?? null);
}

/**
 * Call once at startup. Returns an unsubscribe for tests.
 *
 * The subscriptions carry no selector: the answer is a function of slices in
 * three stores, and a selectorless subscriber runs on every write to any of
 * them, including the persist middleware restoring a switch left on.
 *
 * Another tab's write is picked up here too, gated on
 * {@link ownsPersistedPreference} and then settled through the same
 * {@link onAuthChange} an account change runs. A second window can sign the
 * browser into a different account, so the owner named in the event is checked
 * before anything is restored, and only a payload this tab may hold reaches
 * the store or the gate.
 */
export function setupCameraGateHudAccessSync(): () => void {
  onAuthChange();
  const unsubscribeAuth = useAuthStore.subscribe(onAuthChange);
  const unsubscribeFlags = useClientFeatureFlagStore.subscribe(
    applyEffectiveOptions,
  );
  const unsubscribeDebug = useCameraGateDebugStore.subscribe(
    applyEffectiveOptions,
  );
  const unwatchStorage = watchCameraGateDebugStorage(
    ownsPersistedPreference,
    onAuthChange,
  );
  return () => {
    unsubscribeAuth();
    unsubscribeFlags();
    unsubscribeDebug();
    unwatchStorage();
  };
}

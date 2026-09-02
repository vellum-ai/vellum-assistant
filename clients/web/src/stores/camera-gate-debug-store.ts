/**
 * Zustand store for the camera frame gate's tuning readout.
 *
 * Owns two things: whether the readout is on, and the threshold values its
 * sliders hold. The camera's view options write the first, the readout writes
 * the second, and both are remembered across reloads so a tuning session
 * survives the dev-server restarts that tuning involves.
 *
 * **Storage model:**
 *
 * - The persist middleware serialises the slice into one localStorage key,
 *   `vellum:debug:cameraGateHud`. The `vellum:debug:` namespace is what gets
 *   the key captured into a support export, so a report filed from a session
 *   with a moved threshold says so (see `lib/feature-flags/debug-flag-snapshot.ts`).
 * - A persisted payload is never trusted. Every restored value is clamped to
 *   its slider's range on the way in, the interval pair is put back the right
 *   way round, and anything missing or unparseable falls back to the shipped
 *   default, so what the sliders draw is what the gate is judging against.
 * - The account that tuned it is stored beside it. A restored preference is
 *   only ever applied to the account it belongs to: `claimForUser` drops it
 *   for anyone else, so a shared browser never hands one person's thresholds
 *   to the next, whether the previous session was signed out of or expired.
 * - Cross-tab updates: the persist middleware doesn't sync across tabs on its
 *   own. {@link watchCameraGateDebugStorage} listens for `storage` events on
 *   the key and re-reads the slice, so every window the account has open
 *   agrees about the switch rather than each holding the value it last wrote.
 *   The restored payload goes through the same `merge` a
 *   reload does, so a stale or hand-edited value is clamped exactly as one
 *   from disk. A payload belonging to another account is not restored at all:
 *   the owner named in the event is checked first, by a caller that knows
 *   which account this tab holds.
 *
 * **What every write does.** A write moves this slice and nothing else. The
 * gate's live options record is owned by `lib/camera/frame-gate-debug.ts` and
 * written only from `lib/camera/frame-gate-debug-access.ts`, which subscribes
 * here and pushes the effective picture: this slice, and whether the session
 * may reach the readout at all. That is the seam enforcing the enabled-only
 * rule: the thresholds are written over with the shipped defaults the moment
 * the readout goes off or the session loses access, so an override can never
 * quietly detune a real session.
 *
 * Reference:
 * - {@link https://zustand.docs.pmnd.rs/integrations/persisting-store-data}
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import {
  defaultFrameGateOverrides,
  normalizeFrameGateOverrides,
  syncFrameGateDebugOptions,
  type FrameGateOverrideKey,
  type FrameGateOverrides,
} from "@/lib/camera/frame-gate-debug";
import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface CameraGateDebugState {
  /**
   * Whether the readout collects and renders. Gated again at every call site
   * on staff identity or the `camera-gate-debug-hud` flag, so this alone does
   * not put the panel on screen.
   */
  hudEnabled: boolean;
  /** What the sliders hold. Always a complete set, defaults included. */
  overrides: FrameGateOverrides;
  /**
   * The account this preference belongs to, or null when no account has
   * claimed it. Persisted alongside the preference so the pair travels
   * together: a tuning session is one account's, and the reload that restores
   * it has to know whose before applying it to whoever signs in next.
   */
  ownerUserId: string | null;
}

export interface CameraGateDebugActions {
  setHudEnabled: (next: boolean) => void;
  /**
   * Move one threshold. Takes effect on the next frame the gate judges.
   *
   * The two intervals are coupled: moving one past the other carries the other
   * with it, so both sliders visibly move and the pair stays one the gate can
   * honor.
   */
  setOverride: (key: FrameGateOverrideKey, value: number) => void;
  /** Put every threshold back to the value the gate ships with. */
  resetOverrides: () => void;
  /**
   * Bind the stored preference to the account now signed in, dropping it
   * first unless that account is the one it already belongs to.
   *
   * An owner that is not this account, including one no session ever
   * recorded, means the readout was left on by somebody else, so the switch
   * and the thresholds go back to shipped before the new account can inherit
   * a gate it never tuned.
   */
  claimForUser: (userId: string) => void;
}

export type CameraGateDebugStore = CameraGateDebugState &
  CameraGateDebugActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: CameraGateDebugState = {
  hudEnabled: false,
  overrides: defaultFrameGateOverrides(),
  ownerUserId: null,
};

/**
 * A complete override set built from whatever was stored, so a payload written
 * before a threshold existed still produces a slider with a value on it.
 *
 * Restored values go through the same normalization the gate's writer applies,
 * which is what keeps a slider, its meter's tick, and the number the gate
 * judges against in agreement after bounds tighten or localStorage is
 * hand-edited. A stored interval pair the wrong way round comes back with the
 * ceiling raised to the floor.
 */
function completeOverrides(saved: unknown): FrameGateOverrides {
  const base = defaultFrameGateOverrides();
  if (typeof saved !== "object" || saved === null) {
    return base;
  }
  const partial = saved as Partial<Record<FrameGateOverrideKey, unknown>>;
  for (const key of Object.keys(base) as FrameGateOverrideKey[]) {
    const value = partial[key];
    if (typeof value === "number") {
      base[key] = value;
    }
  }
  return normalizeFrameGateOverrides(base);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const CAMERA_GATE_DEBUG_STORE_KEY = "vellum:debug:cameraGateHud";

const useCameraGateDebugStoreBase = create<CameraGateDebugStore>()(
  persist(
    (set, get) => ({
      ...INITIAL_STATE,

      setHudEnabled: (next: boolean) => {
        set({ hudEnabled: next });
      },

      setOverride: (key: FrameGateOverrideKey, value: number) => {
        set({
          overrides: normalizeFrameGateOverrides(
            { ...get().overrides, [key]: value },
            key,
          ),
        });
      },

      resetOverrides: () => {
        set({ overrides: defaultFrameGateOverrides() });
      },

      claimForUser: (userId: string) => {
        if (get().ownerUserId === userId) {
          return;
        }
        set({
          ownerUserId: userId,
          hudEnabled: false,
          overrides: defaultFrameGateOverrides(),
        });
      },
    }),
    {
      name: CAMERA_GATE_DEBUG_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        hudEnabled: state.hudEnabled,
        overrides: state.overrides,
        ownerUserId: state.ownerUserId,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<CameraGateDebugState> | undefined;
        return {
          ...current,
          hudEnabled: saved?.hudEnabled === true,
          overrides: completeOverrides(saved?.overrides),
          ownerUserId:
            typeof saved?.ownerUserId === "string" ? saved.ownerUserId : null,
        };
      },
    },
  ),
);

export const useCameraGateDebugStore = createSelectors(
  useCameraGateDebugStoreBase,
);

// ---------------------------------------------------------------------------
// Cross-tab sync
// ---------------------------------------------------------------------------

/**
 * The account the payload on the key belongs to, or nothing readable.
 *
 * A `null` owner is a real answer: a slice written before any account claimed
 * it names none, and the claim that follows a restore is what settles those.
 * An absent value (the key was removed) or a payload that does not parse is
 * not an answer at all, and nothing is restored from one.
 */
function readPersistedOwner(
  raw: string | null,
): { readable: true; ownerUserId: string | null } | { readable: false } {
  if (raw === null) {
    return { readable: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { readable: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { readable: false };
  }
  const state = (parsed as { state?: unknown }).state;
  if (typeof state !== "object" || state === null) {
    return { readable: false };
  }
  const owner = (state as { ownerUserId?: unknown }).ownerUserId;
  return {
    readable: true,
    ownerUserId: typeof owner === "string" ? owner : null,
  };
}

/**
 * Re-read this slice when another tab writes one this tab is allowed to hold,
 * and hand back an unsubscribe.
 *
 * The owner is checked BEFORE anything is restored. Adopting a payload and
 * correcting it afterwards looks equivalent and is not: the correction is
 * itself a persisted write, the other tab reads it, corrects it back, and two
 * signed-in accounts trade the key forever. A payload this tab may not hold is
 * therefore left entirely alone, on disk and in memory, and the account that
 * wrote it keeps it until someone's next boot claims it.
 *
 * The split is what each side knows. The payload's shape is this module's, so
 * the owner is parsed here; whether that owner is the one this tab is signed
 * in as is the caller's, so it answers `shouldAccept`. `onRestored` then runs
 * for an accepted payload only.
 *
 * What is checked is the key as it stands, not the value the event carried.
 * Those differ whenever a third write lands between an event being queued and
 * this handler running, and the restore below takes the key rather than the
 * event, so checking the event would be checking something else. Both reads
 * sit in one synchronous block: `persist.rehydrate()` calls `getItem` on a
 * synchronous storage and settles before it returns, so nothing can replace
 * the key between the answer and the restore.
 */
export function watchCameraGateDebugStorage(
  shouldAccept: (ownerUserId: string | null) => boolean,
  onRestored: () => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== CAMERA_GATE_DEBUG_STORE_KEY) {
      return;
    }
    const owner = readPersistedOwner(
      localStorage.getItem(CAMERA_GATE_DEBUG_STORE_KEY),
    );
    if (!owner.readable || !shouldAccept(owner.ownerUserId)) {
      return;
    }
    void Promise.resolve(useCameraGateDebugStoreBase.persist.rehydrate()).then(
      onRestored,
    );
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Put the readout back to its shipped state when a session ends.
 *
 * The key sweep on logout removes what was persisted, but a logout does not
 * reload the tab, so this store's slice and the gate's options record both
 * survive it. A session that ended with the readout on would otherwise leave
 * the next user's camera judging frames against a threshold they never set,
 * with no panel on screen to say so.
 *
 * The record is written here as well as through the subscription, because the
 * value written is unconditionally off: ending a session is the one moment
 * worth being certain about without depending on a listener being registered.
 */
export function clearCameraGateDebug(): void {
  const overrides = defaultFrameGateOverrides();
  useCameraGateDebugStoreBase.setState({
    hudEnabled: false,
    overrides,
    ownerUserId: null,
  });
  syncFrameGateDebugOptions(false, overrides);
}

/**
 * Zustand store for the camera frame gate's tuning readout.
 *
 * Owns two things: whether the readout is on, and the threshold values its
 * sliders hold. The settings panel writes the first, the readout writes the
 * second, and both are remembered across reloads so a tuning session survives
 * the dev-server restarts that tuning involves.
 *
 * **Storage model:**
 *
 * - The persist middleware serialises the slice into one localStorage key,
 *   `vellum:debug:cameraGateHud`. The `vellum:debug:` namespace is what gets
 *   the key captured into a support export, so a report filed from a session
 *   with a moved threshold says so (see `lib/feature-flags/debug-flag-snapshot.ts`).
 * - A persisted payload is never trusted. Every restored value is clamped to
 *   its slider's range on the way in, and anything missing or unparseable
 *   falls back to the shipped default, so what the sliders draw is what the
 *   gate is judging against.
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
  clampFrameGateOverride,
  defaultFrameGateOverrides,
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
}

export interface CameraGateDebugActions {
  setHudEnabled: (next: boolean) => void;
  /** Move one threshold. Takes effect on the next frame the gate judges. */
  setOverride: (key: FrameGateOverrideKey, value: number) => void;
  /** Put every threshold back to the value the gate ships with. */
  resetOverrides: () => void;
}

export type CameraGateDebugStore = CameraGateDebugState &
  CameraGateDebugActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: CameraGateDebugState = {
  hudEnabled: false,
  overrides: defaultFrameGateOverrides(),
};

/**
 * A complete override set built from whatever was stored, so a payload written
 * before a threshold existed still produces a slider with a value on it.
 *
 * Restored values go through the same clamp the gate's writer applies, which
 * is what keeps a slider, its meter's tick, and the number the gate judges
 * against in agreement after bounds tighten or localStorage is hand-edited.
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
      base[key] = clampFrameGateOverride(key, value);
    }
  }
  return base;
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
          overrides: {
            ...get().overrides,
            [key]: clampFrameGateOverride(key, value),
          },
        });
      },

      resetOverrides: () => {
        set({ overrides: defaultFrameGateOverrides() });
      },
    }),
    {
      name: CAMERA_GATE_DEBUG_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        hudEnabled: state.hudEnabled,
        overrides: state.overrides,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<CameraGateDebugState> | undefined;
        return {
          ...current,
          hudEnabled: saved?.hudEnabled === true,
          overrides: completeOverrides(saved?.overrides),
        };
      },
    },
  ),
);

export const useCameraGateDebugStore = createSelectors(
  useCameraGateDebugStoreBase,
);

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
  useCameraGateDebugStoreBase.setState({ hudEnabled: false, overrides });
  syncFrameGateDebugOptions(false, overrides);
}

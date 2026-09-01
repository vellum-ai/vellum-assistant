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
 * - A persisted payload is never trusted as gate input. It reaches the gate
 *   only through {@link syncFrameGateDebugOptions}, which clamps each value to
 *   its slider's range and falls back to the shipped default for anything
 *   missing or unparseable.
 *
 * **What every write does.** Both setters push the whole picture back through
 * `syncFrameGateDebugOptions`, which is the module that owns the gate's live
 * options record. That is the seam enforcing the enabled-only rule: a
 * threshold moved while the readout is on is written over with the shipped
 * default the moment it goes off, so an override can never quietly detune a
 * real session.
 *
 * Reference:
 * - {@link https://zustand.docs.pmnd.rs/integrations/persisting-store-data}
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import {
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
 */
function completeOverrides(saved: unknown): FrameGateOverrides {
  const base = defaultFrameGateOverrides();
  if (typeof saved !== "object" || saved === null) {
    return base;
  }
  const partial = saved as Partial<Record<FrameGateOverrideKey, unknown>>;
  for (const key of Object.keys(base) as FrameGateOverrideKey[]) {
    const value = partial[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      base[key] = value;
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
        syncFrameGateDebugOptions(next, get().overrides);
      },

      setOverride: (key: FrameGateOverrideKey, value: number) => {
        const overrides = { ...get().overrides, [key]: value };
        set({ overrides });
        syncFrameGateDebugOptions(get().hudEnabled, overrides);
      },

      resetOverrides: () => {
        const overrides = defaultFrameGateOverrides();
        set({ overrides });
        syncFrameGateDebugOptions(get().hudEnabled, overrides);
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
 */
export function clearCameraGateDebug(): void {
  const overrides = defaultFrameGateOverrides();
  useCameraGateDebugStoreBase.setState({ hudEnabled: false, overrides });
  syncFrameGateDebugOptions(false, overrides);
}

// The gate reads its options from a plain record rather than from this store,
// so a reload that restores an enabled readout has to push the restored values
// into that record before the first frame is judged.
syncFrameGateDebugOptions(
  useCameraGateDebugStoreBase.getState().hudEnabled,
  useCameraGateDebugStoreBase.getState().overrides,
);

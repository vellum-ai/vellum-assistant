/**
 * What the readout's store persists, and what every write does to the options
 * record the gate is holding.
 *
 * The store is the only writer of that record, so these two are one subject:
 * a persisted payload is worth nothing if it never reaches the gate, and a
 * value that reaches the gate while the readout is off is the failure the
 * enabled-only rule exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_FRAME_GATE_OPTIONS } from "@/lib/camera/frame-gate";
import {
  FRAME_GATE_LIVE_OPTIONS,
  defaultFrameGateOverrides,
} from "@/lib/camera/frame-gate-debug";
import { useCameraGateDebugStore } from "@/stores/camera-gate-debug-store";

const STORAGE_KEY = "vellum:debug:cameraGateHud";

const initialState = useCameraGateDebugStore.getState();

function persisted(): { hudEnabled?: boolean; overrides?: unknown } {
  const raw = localStorage.getItem(STORAGE_KEY);
  expect(raw).not.toBeNull();
  return JSON.parse(raw ?? "{}").state;
}

beforeEach(() => {
  useCameraGateDebugStore.setState(
    { ...initialState, overrides: defaultFrameGateOverrides() },
    true,
  );
  localStorage.removeItem(STORAGE_KEY);
});

afterEach(() => {
  useCameraGateDebugStore.getState().setHudEnabled(false);
  useCameraGateDebugStore.setState(
    { ...initialState, overrides: defaultFrameGateOverrides() },
    true,
  );
  localStorage.removeItem(STORAGE_KEY);
});

describe("camera gate debug store", () => {
  test("persists the enable bit and every threshold, and nothing else", () => {
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("noveltyThreshold", 0.9);

    const state = persisted();
    expect(state.hudEnabled).toBe(true);
    expect(state.overrides).toEqual({
      ...defaultFrameGateOverrides(),
      noveltyThreshold: 0.9,
    });
    expect(Object.keys(state).sort()).toEqual(["hudEnabled", "overrides"]);
  });

  test("a threshold written while the readout is on reaches the gate", () => {
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("minIntervalMs", 1_000);

    expect(useCameraGateDebugStore.getState().overrides.minIntervalMs).toBe(
      1_000,
    );
    expect(FRAME_GATE_LIVE_OPTIONS.minIntervalMs).toBe(1_000);
  });

  test("a threshold written while the readout is off never reaches the gate", () => {
    useCameraGateDebugStore.getState().setOverride("minIntervalMs", 1_000);

    expect(useCameraGateDebugStore.getState().overrides.minIntervalMs).toBe(
      1_000,
    );
    expect(FRAME_GATE_LIVE_OPTIONS.minIntervalMs).toBe(
      DEFAULT_FRAME_GATE_OPTIONS.minIntervalMs,
    );
  });

  test("turning the readout off puts the shipped defaults back on the gate", () => {
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("settleThreshold", 0.25);
    expect(FRAME_GATE_LIVE_OPTIONS.settleThreshold).toBe(0.25);

    store.setHudEnabled(false);

    expect({ ...FRAME_GATE_LIVE_OPTIONS }).toEqual({
      ...DEFAULT_FRAME_GATE_OPTIONS,
    });
    // The slider keeps the value it was left on, so turning the readout back
    // on resumes the session rather than starting it over.
    expect(useCameraGateDebugStore.getState().overrides.settleThreshold).toBe(
      0.25,
    );
  });

  test("reset puts every slider and the gate back to the defaults", () => {
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("noveltyThreshold", 1.4);
    store.setOverride("minDetail", 30);

    store.resetOverrides();

    expect(useCameraGateDebugStore.getState().overrides).toEqual(
      defaultFrameGateOverrides(),
    );
    expect({ ...FRAME_GATE_LIVE_OPTIONS }).toEqual({
      ...DEFAULT_FRAME_GATE_OPTIONS,
    });
  });
});

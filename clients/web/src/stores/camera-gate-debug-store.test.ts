/**
 * What the readout's store persists, and what every write ends up doing to the
 * options record the gate is holding.
 *
 * The two are one subject: a persisted payload is worth nothing if it never
 * reaches the gate, and a value that reaches the gate while the readout is off
 * is the failure the enabled-only rule exists to prevent. These tests run the
 * access sync the app boots with, which is what carries a write from here to
 * the gate.
 *
 * The store holds only values a slider could produce. A readout drawing a
 * threshold the gate is not judging against describes a session that does not
 * exist, so clamping happens where the value is stored, not only on its way to
 * the record.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_FRAME_GATE_OPTIONS } from "@/lib/camera/frame-gate";
import {
  FRAME_GATE_LIVE_OPTIONS,
  FRAME_GATE_SLIDER_BOUNDS,
  defaultFrameGateOverrides,
  syncFrameGateDebugOptions,
} from "@/lib/camera/frame-gate-debug";
import { setupCameraGateHudAccessSync } from "@/lib/camera/frame-gate-debug-access";
import {
  clearCameraGateDebug,
  useCameraGateDebugStore,
} from "@/stores/camera-gate-debug-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

const STORAGE_KEY = "vellum:debug:cameraGateHud";

const initialState = useCameraGateDebugStore.getState();

let stopAccessSync: (() => void) | null = null;

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
  // The flag is what makes this session one that may reach the readout, which
  // is the other half of what the gate is handed.
  useClientFeatureFlagStore.setState({ cameraGateDebugHud: true });
  stopAccessSync = setupCameraGateHudAccessSync();
});

afterEach(() => {
  stopAccessSync?.();
  stopAccessSync = null;
  useCameraGateDebugStore.setState(
    { ...initialState, overrides: defaultFrameGateOverrides() },
    true,
  );
  syncFrameGateDebugOptions(false, defaultFrameGateOverrides());
  useClientFeatureFlagStore.setState({ cameraGateDebugHud: false });
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
    expect(Object.keys(state).sort()).toEqual([
      "hudEnabled",
      "overrides",
      "ownerUserId",
    ]);
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

  test("a session ending takes the readout and its thresholds with it", () => {
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("noveltyThreshold", 1.1);

    clearCameraGateDebug();

    expect(useCameraGateDebugStore.getState().hudEnabled).toBe(false);
    expect(useCameraGateDebugStore.getState().overrides).toEqual(
      defaultFrameGateOverrides(),
    );
    expect({ ...FRAME_GATE_LIVE_OPTIONS }).toEqual({
      ...DEFAULT_FRAME_GATE_OPTIONS,
    });
  });

  test("a threshold moved past its slider's range is clamped where it is stored", () => {
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("minIntervalMs", 1_000_000);

    const { max } = FRAME_GATE_SLIDER_BOUNDS.minIntervalMs;
    expect(useCameraGateDebugStore.getState().overrides.minIntervalMs).toBe(
      max,
    );
    expect(FRAME_GATE_LIVE_OPTIONS.minIntervalMs).toBe(max);
  });

  test("a threshold moved below its slider's range is clamped where it is stored", () => {
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("maxIntervalMs", 0);

    const { min } = FRAME_GATE_SLIDER_BOUNDS.maxIntervalMs;
    expect(useCameraGateDebugStore.getState().overrides.maxIntervalMs).toBe(
      min,
    );
    expect(FRAME_GATE_LIVE_OPTIONS.maxIntervalMs).toBe(min);
  });

  test("a restored threshold outside its slider's range is clamped, not just on the gate", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          hudEnabled: true,
          overrides: { ...defaultFrameGateOverrides(), noveltyThreshold: 99 },
        },
        version: 0,
      }),
    );

    await useCameraGateDebugStore.persist.rehydrate();

    const { max } = FRAME_GATE_SLIDER_BOUNDS.noveltyThreshold;
    expect(useCameraGateDebugStore.getState().hudEnabled).toBe(true);
    expect(useCameraGateDebugStore.getState().overrides.noveltyThreshold).toBe(
      max,
    );
    expect(FRAME_GATE_LIVE_OPTIONS.noveltyThreshold).toBe(max);
  });

  test("a restored threshold that is not a number falls back to the shipped default", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          hudEnabled: true,
          overrides: { ...defaultFrameGateOverrides(), minDetail: "loads" },
        },
        version: 0,
      }),
    );

    await useCameraGateDebugStore.persist.rehydrate();

    expect(useCameraGateDebugStore.getState().overrides.minDetail).toBe(
      DEFAULT_FRAME_GATE_OPTIONS.minDetail,
    );
    expect(FRAME_GATE_LIVE_OPTIONS.minDetail).toBe(
      DEFAULT_FRAME_GATE_OPTIONS.minDetail,
    );
  });

  test("raising the floor past the ceiling carries the ceiling up with it", () => {
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("maxIntervalMs", 10_000);

    store.setOverride("minIntervalMs", 20_000);

    const { overrides } = useCameraGateDebugStore.getState();
    expect(overrides.minIntervalMs).toBe(20_000);
    expect(overrides.maxIntervalMs).toBe(20_000);
    expect(FRAME_GATE_LIVE_OPTIONS.minIntervalMs).toBe(20_000);
    expect(FRAME_GATE_LIVE_OPTIONS.maxIntervalMs).toBe(20_000);
  });

  test("dropping the ceiling below the floor carries the floor down with it", () => {
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("minIntervalMs", 12_000);

    store.setOverride("maxIntervalMs", 3_000);

    const { overrides } = useCameraGateDebugStore.getState();
    expect(overrides.minIntervalMs).toBe(3_000);
    expect(overrides.maxIntervalMs).toBe(3_000);
    expect(FRAME_GATE_LIVE_OPTIONS.minIntervalMs).toBe(3_000);
    expect(FRAME_GATE_LIVE_OPTIONS.maxIntervalMs).toBe(3_000);
  });

  test("an interval write that keeps the pair ordered moves only what was set", () => {
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);

    store.setOverride("minIntervalMs", 1_000);

    const { overrides } = useCameraGateDebugStore.getState();
    expect(overrides.minIntervalMs).toBe(1_000);
    expect(overrides.maxIntervalMs).toBe(
      DEFAULT_FRAME_GATE_OPTIONS.maxIntervalMs,
    );
  });

  test("a restored pair the wrong way round raises the ceiling to the floor", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          hudEnabled: true,
          overrides: {
            ...defaultFrameGateOverrides(),
            minIntervalMs: 25_000,
            maxIntervalMs: 2_000,
          },
        },
        version: 0,
      }),
    );

    await useCameraGateDebugStore.persist.rehydrate();

    const { overrides } = useCameraGateDebugStore.getState();
    expect(overrides.minIntervalMs).toBe(25_000);
    expect(overrides.maxIntervalMs).toBe(25_000);
    expect(FRAME_GATE_LIVE_OPTIONS.maxIntervalMs).toBe(25_000);
  });

  test("the shipped defaults are already ordered, so nothing moves them", () => {
    expect(DEFAULT_FRAME_GATE_OPTIONS.minIntervalMs).toBeLessThanOrEqual(
      DEFAULT_FRAME_GATE_OPTIONS.maxIntervalMs,
    );
    expect(defaultFrameGateOverrides()).toEqual({
      noveltyThreshold: DEFAULT_FRAME_GATE_OPTIONS.noveltyThreshold,
      settleThreshold: DEFAULT_FRAME_GATE_OPTIONS.settleThreshold,
      minDetail: DEFAULT_FRAME_GATE_OPTIONS.minDetail,
      minIntervalMs: DEFAULT_FRAME_GATE_OPTIONS.minIntervalMs,
      maxIntervalMs: DEFAULT_FRAME_GATE_OPTIONS.maxIntervalMs,
    });
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

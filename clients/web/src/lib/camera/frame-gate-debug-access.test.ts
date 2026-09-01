/**
 * What a session that may not reach the readout runs the camera gate against.
 *
 * The persisted switch is only half the answer. A session whose access goes
 * away keeps its switch and its slider values, and the gate goes back to the
 * shipped thresholds until access returns, because a tuned gate with no panel
 * on screen reads as a camera that stopped working.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_FRAME_GATE_OPTIONS } from "@/lib/camera/frame-gate";
import {
  FRAME_GATE_LIVE_OPTIONS,
  defaultFrameGateOverrides,
  syncFrameGateDebugOptions,
} from "@/lib/camera/frame-gate-debug";
import { setupCameraGateHudAccessSync } from "@/lib/camera/frame-gate-debug-access";
import { useAuthStore, type AuthUser } from "@/stores/auth-store";
import { useCameraGateDebugStore } from "@/stores/camera-gate-debug-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

const STORAGE_KEY = "vellum:debug:cameraGateHud";

const STAFF_USER: AuthUser = {
  kind: "platform",
  id: "user-1",
  username: "staffer",
  email: "staffer@vellum.ai",
  isStaff: true,
  firstName: "Staff",
  lastName: "Member",
};

const LOCAL_USER: AuthUser = {
  kind: "local",
  id: "gateway-local",
  username: null,
  email: null,
  isStaff: false,
  firstName: "",
  lastName: "",
};

const initialAuthState = useAuthStore.getState();
const initialDebugState = useCameraGateDebugStore.getState();

let stopAccessSync: (() => void) | null = null;

function persistedHudEnabled(): boolean | undefined {
  const raw = localStorage.getItem(STORAGE_KEY);
  expect(raw).not.toBeNull();
  return JSON.parse(raw ?? "{}").state?.hudEnabled;
}

function resetStores(): void {
  useCameraGateDebugStore.setState(
    {
      ...initialDebugState,
      hudEnabled: false,
      overrides: defaultFrameGateOverrides(),
    },
    true,
  );
  useClientFeatureFlagStore.setState({ cameraGateDebugHud: false });
  useAuthStore.setState({ user: LOCAL_USER });
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  resetStores();
  stopAccessSync = setupCameraGateHudAccessSync();
});

afterEach(() => {
  stopAccessSync?.();
  stopAccessSync = null;
  resetStores();
  syncFrameGateDebugOptions(false, defaultFrameGateOverrides());
  useAuthStore.setState(initialAuthState, true);
  localStorage.removeItem(STORAGE_KEY);
});

describe("camera gate readout access", () => {
  test("a session that loses the flag stops tuning the gate and keeps its preference", () => {
    useClientFeatureFlagStore.setState({ cameraGateDebugHud: true });
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("noveltyThreshold", 1.5);
    expect(FRAME_GATE_LIVE_OPTIONS.noveltyThreshold).toBe(1.5);

    useClientFeatureFlagStore.setState({ cameraGateDebugHud: false });

    expect({ ...FRAME_GATE_LIVE_OPTIONS }).toEqual({
      ...DEFAULT_FRAME_GATE_OPTIONS,
    });
    expect(useCameraGateDebugStore.getState().hudEnabled).toBe(true);
    expect(useCameraGateDebugStore.getState().overrides.noveltyThreshold).toBe(
      1.5,
    );
    expect(persistedHudEnabled()).toBe(true);
  });

  test("a session that stops being staff stops tuning the gate", () => {
    useAuthStore.setState({ user: STAFF_USER });
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("minDetail", 30);
    expect(FRAME_GATE_LIVE_OPTIONS.minDetail).toBe(30);

    useAuthStore.setState({ user: LOCAL_USER });

    expect({ ...FRAME_GATE_LIVE_OPTIONS }).toEqual({
      ...DEFAULT_FRAME_GATE_OPTIONS,
    });
    expect(useCameraGateDebugStore.getState().overrides.minDetail).toBe(30);
    expect(persistedHudEnabled()).toBe(true);
  });

  test("access coming back puts the thresholds it was left on back on the gate", () => {
    useAuthStore.setState({ user: STAFF_USER });
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("settleThreshold", 0.25);
    useAuthStore.setState({ user: LOCAL_USER });
    expect(FRAME_GATE_LIVE_OPTIONS.settleThreshold).toBe(
      DEFAULT_FRAME_GATE_OPTIONS.settleThreshold,
    );

    useAuthStore.setState({ user: STAFF_USER });

    expect(FRAME_GATE_LIVE_OPTIONS.settleThreshold).toBe(0.25);
  });

  test("a switch left on by a session with no access never reaches the gate", () => {
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("minIntervalMs", 1_000);

    expect({ ...FRAME_GATE_LIVE_OPTIONS }).toEqual({
      ...DEFAULT_FRAME_GATE_OPTIONS,
    });
  });
});

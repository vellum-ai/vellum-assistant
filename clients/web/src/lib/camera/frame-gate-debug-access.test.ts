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

/**
 * The same account as {@link STAFF_USER}, no longer staff. Same id, so it
 * moves availability without moving identity, which is what the tests below
 * are about.
 */
const DEMOTED_USER: AuthUser = {
  ...STAFF_USER,
  email: "person@example.com",
  isStaff: false,
};

const OTHER_STAFF_USER: AuthUser = {
  kind: "platform",
  id: "user-2",
  username: "colleague",
  email: "colleague@vellum.ai",
  isStaff: true,
  firstName: "Other",
  lastName: "Staffer",
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

    useAuthStore.setState({ user: DEMOTED_USER });

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
    useAuthStore.setState({ user: DEMOTED_USER });
    expect(FRAME_GATE_LIVE_OPTIONS.settleThreshold).toBe(
      DEFAULT_FRAME_GATE_OPTIONS.settleThreshold,
    );

    useAuthStore.setState({ user: STAFF_USER });

    expect(FRAME_GATE_LIVE_OPTIONS.settleThreshold).toBe(0.25);
  });

  test("a session that expires without a logout leaves nothing for the next account", () => {
    useAuthStore.setState({ user: STAFF_USER });
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("noveltyThreshold", 1.3);

    // An expired or revoked session ends without the logout sweep running.
    useAuthStore.setState({ user: null });
    useAuthStore.setState({ user: OTHER_STAFF_USER });

    const state = useCameraGateDebugStore.getState();
    expect(state.hudEnabled).toBe(false);
    expect(state.overrides).toEqual(defaultFrameGateOverrides());
    expect({ ...FRAME_GATE_LIVE_OPTIONS }).toEqual({
      ...DEFAULT_FRAME_GATE_OPTIONS,
    });
    expect(persistedHudEnabled()).toBe(false);
  });

  test("a different account signing in straight after another finds nothing of theirs", () => {
    useAuthStore.setState({ user: STAFF_USER });
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("minDetail", 42);

    useAuthStore.setState({ user: OTHER_STAFF_USER });

    const state = useCameraGateDebugStore.getState();
    expect(state.hudEnabled).toBe(false);
    expect(state.overrides.minDetail).toBe(
      DEFAULT_FRAME_GATE_OPTIONS.minDetail,
    );
  });

  test("a stored preference from another account is dropped on the next load", async () => {
    // What a reload finds: the slice restored from the account that tuned it,
    // with a different one about to sign in.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          hudEnabled: true,
          ownerUserId: STAFF_USER.id,
          overrides: { ...defaultFrameGateOverrides(), minDetail: 42 },
        },
        version: 0,
      }),
    );
    await useCameraGateDebugStore.persist.rehydrate();

    useAuthStore.setState({ user: OTHER_STAFF_USER });

    const state = useCameraGateDebugStore.getState();
    expect(state.hudEnabled).toBe(false);
    expect(state.overrides).toEqual(defaultFrameGateOverrides());
  });

  test("the same account returning through a no-user window keeps its tuning", () => {
    useAuthStore.setState({ user: STAFF_USER });
    const store = useCameraGateDebugStore.getState();
    store.setHudEnabled(true);
    store.setOverride("minDetail", 42);

    // Boot and a token refresh both pass through a window with no user, and
    // neither is a change of account.
    useAuthStore.setState({ user: null });
    useAuthStore.setState({ user: STAFF_USER });

    const state = useCameraGateDebugStore.getState();
    expect(state.hudEnabled).toBe(true);
    expect(state.overrides.minDetail).toBe(42);
    expect(FRAME_GATE_LIVE_OPTIONS.minDetail).toBe(42);
  });

  test("a boot that resolves its user does not disturb a restored preference", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          hudEnabled: true,
          ownerUserId: STAFF_USER.id,
          overrides: { ...defaultFrameGateOverrides(), minDetail: 42 },
        },
        version: 0,
      }),
    );
    await useCameraGateDebugStore.persist.rehydrate();

    useAuthStore.setState({ user: STAFF_USER });

    const state = useCameraGateDebugStore.getState();
    expect(state.hudEnabled).toBe(true);
    expect(state.overrides.minDetail).toBe(42);
    expect(FRAME_GATE_LIVE_OPTIONS.minDetail).toBe(42);
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

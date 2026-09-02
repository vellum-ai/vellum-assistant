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

  /**
   * What another window's write does to this one.
   *
   * The owner check is this module's and the payload's shape is the store's,
   * which is the whole reason the listener is wired here: a second window can
   * sign the browser into a different account, so the payload it leaves behind
   * is not automatically this tab's to read.
   */
  describe("another tab's write", () => {
    /** The payload a tab owned by `ownerUserId` leaves on the key. */
    function payloadFrom(ownerUserId: string, minDetail: number): string {
      return JSON.stringify({
        state: {
          hudEnabled: true,
          ownerUserId,
          overrides: { ...defaultFrameGateOverrides(), minDetail },
        },
        version: 0,
      });
    }

    /** Leave a payload behind and tell this tab about it, as another tab does. */
    async function arriveFromAnotherTab(
      ownerUserId: string,
      minDetail: number,
    ): Promise<void> {
      const newValue = payloadFrom(ownerUserId, minDetail);
      localStorage.setItem(STORAGE_KEY, newValue);
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue }),
      );
      await Promise.resolve();
      await Promise.resolve();
    }

    /** Leave the key holding something this tab could not read, and announce it. */
    async function arriveUnreadable(raw: string | null): Promise<void> {
      if (raw === null) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, raw);
      }
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue: raw }),
      );
      await Promise.resolve();
      await Promise.resolve();
    }

    test("from the same account reaches this tab, and the gate with it", async () => {
      useAuthStore.setState({ user: STAFF_USER });
      useCameraGateDebugStore.getState().setHudEnabled(false);

      await arriveFromAnotherTab(STAFF_USER.id ?? "", 42);

      const state = useCameraGateDebugStore.getState();
      expect(state.hudEnabled).toBe(true);
      expect(state.overrides.minDetail).toBe(42);
      expect(FRAME_GATE_LIVE_OPTIONS.minDetail).toBe(42);
    });

    test("naming no owner is read, and the claim then settles it", async () => {
      // A slice written before any account claimed it. Nobody owns it, so
      // there is no account for this tab to disagree with and it is read; the
      // claim that follows is what binds it, and binding a preference no
      // session recorded is what puts the switch back to shipped. That is the
      // store's standing rule for an unowned payload, not a new one.
      useAuthStore.setState({ user: STAFF_USER });
      const store = useCameraGateDebugStore.getState();
      store.setHudEnabled(true);
      store.setOverride("minDetail", 30);

      const newValue = JSON.stringify({
        state: {
          hudEnabled: true,
          ownerUserId: null,
          overrides: { ...defaultFrameGateOverrides(), minDetail: 42 },
        },
        version: 0,
      });
      localStorage.setItem(STORAGE_KEY, newValue);
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue }),
      );
      await Promise.resolve();
      await Promise.resolve();

      const state = useCameraGateDebugStore.getState();
      expect(state.ownerUserId).toBe(STAFF_USER.id);
      expect(state.hudEnabled).toBe(false);
      expect(state.overrides.minDetail).toBe(
        DEFAULT_FRAME_GATE_OPTIONS.minDetail,
      );
    });

    test("from another account is refused outright, with nothing written back", async () => {
      // Adopting it and correcting afterwards would persist the correction,
      // the other tab would read that and correct it back, and two signed-in
      // accounts would trade the key with nobody touching a switch. Refusing
      // to read it is what has no second half.
      useAuthStore.setState({ user: STAFF_USER });
      const store = useCameraGateDebugStore.getState();
      store.setHudEnabled(true);
      store.setOverride("minDetail", 30);

      const foreign = payloadFrom(OTHER_STAFF_USER.id ?? "", 42);
      localStorage.setItem(STORAGE_KEY, foreign);

      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue: foreign }),
      );
      await Promise.resolve();
      await Promise.resolve();

      // Nothing of this tab's moved, and nothing of this tab's was written:
      // the key still holds the other account's payload byte for byte, which
      // is theirs until somebody's next boot claims it. A correction would
      // have replaced it with one owned by this account, which is the write
      // the other tab would have answered.
      const state = useCameraGateDebugStore.getState();
      expect(state.hudEnabled).toBe(true);
      expect(state.overrides.minDetail).toBe(30);
      expect(state.ownerUserId).toBe(STAFF_USER.id);
      expect(FRAME_GATE_LIVE_OPTIONS.minDetail).toBe(30);
      expect(localStorage.getItem(STORAGE_KEY)).toBe(foreign);
    });

    test("that cannot be read is left alone", async () => {
      // A key that was removed, a hand-edited value, and a payload with no
      // state in it. None of them says whose preference this is, so none is
      // acted on, and none throws out of the handler. The last shape is the
      // one a restore would visibly take: it parses, so a handler that went
      // ahead would merge it and put this session's switch out.
      useAuthStore.setState({ user: STAFF_USER });
      useCameraGateDebugStore.getState().setHudEnabled(true);

      await arriveUnreadable(null);
      await arriveUnreadable("not json at all");
      await arriveUnreadable(JSON.stringify({ version: 0 }));

      expect(useCameraGateDebugStore.getState().hudEnabled).toBe(true);
    });

    test("is checked against the key as it stands, not the value it announced", async () => {
      // A third window replaces the key between this event being queued and
      // this handler running. The event still names this account, and the
      // restore would take the key, so trusting the event would smuggle the
      // other account's payload in behind a check that passed.
      useAuthStore.setState({ user: STAFF_USER });
      const store = useCameraGateDebugStore.getState();
      store.setHudEnabled(true);
      store.setOverride("minDetail", 30);

      const announced = payloadFrom(STAFF_USER.id ?? "", 42);
      const onDiskNow = payloadFrom(OTHER_STAFF_USER.id ?? "", 99);
      localStorage.setItem(STORAGE_KEY, onDiskNow);

      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue: announced }),
      );
      await Promise.resolve();
      await Promise.resolve();

      const state = useCameraGateDebugStore.getState();
      expect(state.hudEnabled).toBe(true);
      expect(state.overrides.minDetail).toBe(30);
      expect(FRAME_GATE_LIVE_OPTIONS.minDetail).toBe(30);
      // Byte for byte what the third window left, so this tab wrote nothing.
      expect(localStorage.getItem(STORAGE_KEY)).toBe(onDiskNow);
    });

    test("under another key is not this store's to answer", async () => {
      useAuthStore.setState({ user: STAFF_USER });
      useCameraGateDebugStore.getState().setHudEnabled(true);

      // A payload nobody announced. Reading it would mean any key's event
      // restores this slice, which is a switch moving under a session that
      // changed nothing.
      localStorage.setItem(STORAGE_KEY, payloadFrom(STAFF_USER.id ?? "", 42));
      localStorage.setItem("vellum:debug:somethingElse", "{}");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "vellum:debug:somethingElse",
          newValue: "{}",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(useCameraGateDebugStore.getState().hudEnabled).toBe(true);
      localStorage.removeItem("vellum:debug:somethingElse");
    });

    test("stops arriving once the access sync is torn down", async () => {
      useAuthStore.setState({ user: STAFF_USER });
      useCameraGateDebugStore.getState().setHudEnabled(false);
      stopAccessSync?.();
      stopAccessSync = null;

      await arriveFromAnotherTab(STAFF_USER.id ?? "", 42);

      expect(useCameraGateDebugStore.getState().hudEnabled).toBe(false);
    });
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

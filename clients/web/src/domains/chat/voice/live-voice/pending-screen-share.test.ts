/**
 * A share asked for before there was a call: what waits, what applies it, and
 * every way it is dropped instead.
 *
 * The store is real, because the whole question is which session a target
 * reaches, and a fake one would answer it by construction. What each case
 * does is move the session between the states the gesture spans.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { WatchCaptureTarget } from "@vellumai/ipc-contract";

import {
  useLiveVoiceStore,
  setLiveVoiceScreenShare,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  expectScreenShare,
  forgetPendingScreenShare,
  hasPendingScreenShare,
  parkScreenShare,
  PENDING_SCREEN_SHARE_TTL_MS,
} from "@/domains/chat/voice/live-voice/pending-screen-share";

const SCREEN: WatchCaptureTarget = { kind: "display", displayId: 3 };
const OTHER_SCREEN: WatchCaptureTarget = { kind: "display", displayId: 9 };

/** Bring a session up, which is the edge the parked target is waiting on. */
const connect = (): void => {
  useLiveVoiceStore.getState().setState("listening");
};

const shared = (): WatchCaptureTarget | null =>
  useLiveVoiceStore.getState().screenShareTarget;

describe("a share asked for before the call", () => {
  beforeEach(() => {
    forgetPendingScreenShare();
    useLiveVoiceStore.getState().setState("idle");
    useLiveVoiceStore.getState().setScreenShareTarget(null);
  });

  afterEach(() => {
    forgetPendingScreenShare();
    useLiveVoiceStore.getState().setState("idle");
    useLiveVoiceStore.getState().setScreenShareTarget(null);
  });

  test("is shown to the session the moment it arrives", () => {
    expectScreenShare();
    expect(parkScreenShare(SCREEN)).toBe(true);
    expect(shared()).toBeNull();

    connect();

    expect(shared()).toEqual(SCREEN);
    expect(hasPendingScreenShare()).toBe(false);
  });

  /**
   * The ordinary press on the pill, made with no session running: a target
   * with nothing to show it to is dropped, and this module is not what keeps
   * it. Only a gesture that started a call parks anything.
   */
  test("takes nothing that was not asked for", () => {
    expect(parkScreenShare(SCREEN)).toBe(false);

    connect();

    expect(shared()).toBeNull();
  });

  /**
   * The dial ended: the user closed the pill on a call that never connected.
   * The screen they asked to show it goes with the call they asked it of, or
   * it would open on whatever session came next.
   */
  test("is dropped when the call it rode on is cancelled", () => {
    expectScreenShare();
    parkScreenShare(SCREEN);

    forgetPendingScreenShare();
    connect();

    expect(shared()).toBeNull();
  });

  /**
   * A call that never arrives leaves nothing armed behind it. Without the
   * bound, a gesture made and forgotten an hour ago would share a screen the
   * moment the user next started a call by any other means.
   */
  test("is dropped once it has outlived the start it was made with", () => {
    expectScreenShare();
    parkScreenShare(SCREEN);

    const realNow = Date.now;
    Date.now = () => realNow() + PENDING_SCREEN_SHARE_TTL_MS + 1;
    try {
      connect();
    } finally {
      Date.now = realNow;
    }

    expect(shared()).toBeNull();
    expect(hasPendingScreenShare()).toBe(false);
  });

  /**
   * A session already running has nothing to wait for, and a target held back
   * from one would be a share that never starts.
   */
  test("parks nothing while a session is already running", () => {
    expectScreenShare();
    connect();

    expect(parkScreenShare(SCREEN)).toBe(false);
  });

  /** The gesture is one press, and the last one is what the user meant. */
  test("keeps only the target the last gesture resolved", () => {
    expectScreenShare();
    parkScreenShare(SCREEN);
    parkScreenShare(OTHER_SCREEN);

    connect();

    expect(shared()).toEqual(OTHER_SCREEN);
  });

  /**
   * The park is spent on the session it was waiting for. A second call later
   * in the same launch starts with nothing shared.
   */
  test("is spent on the first session it reaches", () => {
    expectScreenShare();
    parkScreenShare(SCREEN);
    connect();
    expect(shared()).toEqual(SCREEN);

    useLiveVoiceStore.getState().setState("idle");
    setLiveVoiceScreenShare(null);
    connect();

    expect(shared()).toBeNull();
  });
});

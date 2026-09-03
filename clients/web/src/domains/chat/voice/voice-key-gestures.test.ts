import { describe, expect, test } from "bun:test";

import {
  DOUBLE_TAP_GAP_MS,
  HOLD_ARMING_MS,
  createVoiceKeyGestureClassifier,
  type VoiceKeyGesture,
} from "@/domains/chat/voice/voice-key-gestures";

/**
 * A clock the tests turn by hand. Timers fire in order as it advances, and
 * within a single `advance` a timer's callback sees the time it was due.
 */
function makeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    setTimeout: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: time + ms, callback });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      const until = time + ms;
      for (;;) {
        let due: { id: number; at: number; callback: () => void } | null = null;
        for (const [id, timer] of timers) {
          if (timer.at <= until && (due === null || timer.at < due.at)) {
            due = { id, ...timer };
          }
        }
        if (due === null) {
          break;
        }
        timers.delete(due.id);
        time = due.at;
        due.callback();
      }
      time = until;
    },
  };
}

function setup() {
  const clock = makeClock();
  const gestures: VoiceKeyGesture["kind"][] = [];
  const classifier = createVoiceKeyGestureClassifier({
    onGesture: (gesture) => gestures.push(gesture.kind),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const press = () => classifier.feed({ state: "down" });
  const release = () => classifier.feed({ state: "up", reason: "released" });
  const chord = () => classifier.feed({ state: "up", reason: "chord" });
  const tap = () => {
    press();
    clock.advance(HOLD_ARMING_MS / 4);
    release();
  };
  return { clock, gestures, classifier, press, release, chord, tap };
}

describe("voice key gestures", () => {
  test("a press that outlasts the arming delay is a hold", () => {
    const { clock, gestures, press, release } = setup();

    press();
    clock.advance(HOLD_ARMING_MS - 1);
    expect(gestures).toEqual([]);
    clock.advance(1);
    expect(gestures).toEqual(["holdStart"]);
    release();
    expect(gestures).toEqual(["holdStart", "holdEnd"]);
  });

  /**
   * A single tap is nothing on purpose. The key belongs to the user and to the
   * OS's own answer to tapping it, and a hold that never armed is exactly
   * the chord-in-flight case the delay exists for.
   */
  test("a single tap is nothing", () => {
    const { clock, gestures, tap } = setup();

    tap();
    clock.advance(DOUBLE_TAP_GAP_MS * 2);

    expect(gestures).toEqual([]);
  });

  test("two taps inside the gap are a double tap, reported on the second release", () => {
    const { clock, gestures, tap, press, release } = setup();

    tap();
    clock.advance(DOUBLE_TAP_GAP_MS);
    press();
    expect(gestures).toEqual([]);
    clock.advance(HOLD_ARMING_MS / 4);
    release();

    expect(gestures).toEqual(["doubleTap"]);
  });

  test("two taps outside the gap are two nothings", () => {
    const { clock, gestures, tap } = setup();

    tap();
    clock.advance(DOUBLE_TAP_GAP_MS + 1);
    tap();

    expect(gestures).toEqual([]);
  });

  /** Three taps are one double tap and one tap, never two double taps. */
  test("a double tap spends both taps", () => {
    const { clock, gestures, tap } = setup();

    tap();
    clock.advance(DOUBLE_TAP_GAP_MS / 2);
    tap();
    clock.advance(DOUBLE_TAP_GAP_MS / 2);
    tap();

    expect(gestures).toEqual(["doubleTap"]);
  });

  /**
   * Fn+arrow releases inside the arming delay too, so the reason on the edge
   * is the only thing between a chord and a tap.
   */
  test("a chord is not a tap, and pairs with nothing", () => {
    const { clock, gestures, tap, press, chord } = setup();

    press();
    clock.advance(HOLD_ARMING_MS / 4);
    chord();
    clock.advance(DOUBLE_TAP_GAP_MS / 2);
    tap();
    expect(gestures).toEqual([]);

    // The other order: a tap, then a chord inside the gap.
    clock.advance(DOUBLE_TAP_GAP_MS * 2);
    tap();
    clock.advance(DOUBLE_TAP_GAP_MS / 2);
    press();
    clock.advance(HOLD_ARMING_MS / 4);
    chord();
    expect(gestures).toEqual([]);
  });

  test("a second press held long is a hold, not a double tap", () => {
    const { clock, gestures, tap, press, release } = setup();

    tap();
    clock.advance(DOUBLE_TAP_GAP_MS / 2);
    press();
    clock.advance(HOLD_ARMING_MS);
    release();

    expect(gestures).toEqual(["holdStart", "holdEnd"]);
  });

  test("a hold pairs with no tap after it", () => {
    const { clock, gestures, tap, press, release } = setup();

    press();
    clock.advance(HOLD_ARMING_MS);
    release();
    clock.advance(DOUBLE_TAP_GAP_MS / 2);
    tap();

    expect(gestures).toEqual(["holdStart", "holdEnd"]);
  });

  test("a hold cut short by a chord still closes", () => {
    const { clock, gestures, press, chord } = setup();

    press();
    clock.advance(HOLD_ARMING_MS);
    chord();

    expect(gestures).toEqual(["holdStart", "holdEnd"]);
  });

  /**
   * An edge missing its reason comes from a host built before edges said why,
   * and reads as a release rather than as nothing.
   */
  test("an up with no reason is a release", () => {
    const { clock, gestures, classifier, press } = setup();

    press();
    clock.advance(HOLD_ARMING_MS / 4);
    classifier.feed({ state: "up" });
    clock.advance(DOUBLE_TAP_GAP_MS / 2);
    press();
    clock.advance(HOLD_ARMING_MS / 4);
    classifier.feed({ state: "up" });

    expect(gestures).toEqual(["doubleTap"]);
  });

  test("cancel closes an open hold and forgets a pending tap", () => {
    const { clock, gestures, classifier, press, tap } = setup();

    press();
    clock.advance(HOLD_ARMING_MS);
    classifier.cancel();
    expect(gestures).toEqual(["holdStart", "holdEnd"]);

    tap();
    classifier.cancel();
    clock.advance(DOUBLE_TAP_GAP_MS / 2);
    tap();
    expect(gestures).toEqual(["holdStart", "holdEnd"]);
  });

  test("a stray up, and a second down, change nothing", () => {
    const { clock, gestures, press, release } = setup();

    release();
    press();
    press();
    clock.advance(HOLD_ARMING_MS);
    release();
    release();

    expect(gestures).toEqual(["holdStart", "holdEnd"]);
  });
});

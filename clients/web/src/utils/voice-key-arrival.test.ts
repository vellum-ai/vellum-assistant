import { describe, expect, test } from "bun:test";

import {
  VOICE_KEY_ARRIVAL_TIMEOUT_MS,
  createVoiceKeyArrivalDetector,
  type VoiceKeyArrival,
} from "@/utils/voice-key-arrival";

/** A clock the tests turn by hand. Timers fire in order as it advances. */
function makeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
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
  const outcomes: VoiceKeyArrival[] = [];
  const detector = createVoiceKeyArrivalDetector({
    onOutcome: (outcome) => outcomes.push(outcome),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, outcomes, detector };
}

describe("voice key arrival", () => {
  test("an edge inside the wait is the press arriving", () => {
    const { clock, outcomes, detector } = setup();

    detector.arm();
    clock.advance(VOICE_KEY_ARRIVAL_TIMEOUT_MS / 2);
    detector.feed({ state: "down" });

    expect(outcomes).toEqual(["arrived"]);
    clock.advance(VOICE_KEY_ARRIVAL_TIMEOUT_MS);
    expect(outcomes).toEqual(["arrived"]);
  });

  test("no edge by the end of the wait is a press that never arrived", () => {
    const { clock, outcomes, detector } = setup();

    detector.arm();
    clock.advance(VOICE_KEY_ARRIVAL_TIMEOUT_MS - 1);
    expect(outcomes).toEqual([]);
    clock.advance(1);
    expect(outcomes).toEqual(["neverArrived"]);
  });

  /** A key already held when the test starts comes up first. */
  test("an up counts as much as a down", () => {
    const { outcomes, detector } = setup();

    detector.arm();
    detector.feed({ state: "up", reason: "released" });

    expect(outcomes).toEqual(["arrived"]);
  });

  test("an up the host made itself is not the user's press", () => {
    const { clock, outcomes, detector } = setup();

    detector.arm();
    detector.feed({ state: "up", reason: "cancelled" });
    expect(outcomes).toEqual([]);
    clock.advance(VOICE_KEY_ARRIVAL_TIMEOUT_MS);
    expect(outcomes).toEqual(["neverArrived"]);
  });

  test("an edge while nothing is expected is nothing", () => {
    const { clock, outcomes, detector } = setup();

    detector.feed({ state: "down" });
    detector.arm();
    detector.feed({ state: "down" });
    detector.feed({ state: "up", reason: "released" });
    clock.advance(VOICE_KEY_ARRIVAL_TIMEOUT_MS);

    expect(outcomes).toEqual(["arrived"]);
  });

  test("arming again starts the wait over", () => {
    const { clock, outcomes, detector } = setup();

    detector.arm();
    clock.advance(VOICE_KEY_ARRIVAL_TIMEOUT_MS - 1);
    detector.arm();
    clock.advance(VOICE_KEY_ARRIVAL_TIMEOUT_MS - 1);
    expect(outcomes).toEqual([]);
    clock.advance(1);
    expect(outcomes).toEqual(["neverArrived"]);
  });

  test("cancel reports nothing", () => {
    const { clock, outcomes, detector } = setup();

    detector.arm();
    detector.cancel();
    clock.advance(VOICE_KEY_ARRIVAL_TIMEOUT_MS);
    detector.feed({ state: "down" });

    expect(outcomes).toEqual([]);
  });
});

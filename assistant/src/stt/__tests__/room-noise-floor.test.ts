import { describe, expect, test } from "bun:test";

import {
  NOISE_FLOOR_BLOCK_COUNT,
  NOISE_FLOOR_BLOCK_MS,
  RoomNoiseFloor,
} from "../room-noise-floor.js";

/** Audio needed before the estimator will report anything at all. */
const FULL_WINDOW_MS = NOISE_FLOOR_BLOCK_MS * NOISE_FLOOR_BLOCK_COUNT;

/** Feed `ms` of audio at a steady amplitude, in 50ms chunks like the client. */
function feed(floor: RoomNoiseFloor, amplitude: number, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    floor.observe(amplitude, 50);
  }
}

describe("RoomNoiseFloor", () => {
  test("has no opinion until the window is full", () => {
    const floor = new RoomNoiseFloor();
    feed(floor, 300, FULL_WINDOW_MS - NOISE_FLOOR_BLOCK_MS);

    // A partial window would report the loudest thing it has heard as the room.
    expect(floor.floor).toBeNull();

    feed(floor, 300, NOISE_FLOOR_BLOCK_MS);
    expect(floor.floor).toBeCloseTo(300, 5);
  });

  test("ignores intermittent speech and keeps the quiet second", () => {
    const floor = new RoomNoiseFloor();
    // Someone talking over a 250-level room, with one pause in the window.
    feed(floor, 2_400, FULL_WINDOW_MS - NOISE_FLOOR_BLOCK_MS);
    feed(floor, 250, NOISE_FLOOR_BLOCK_MS);

    // The minimum picks the second nobody spoke in, not the average of the ten.
    expect(floor.floor).toBeCloseTo(250, 5);
  });

  test("a block averages across syllable gaps rather than latching onto one", () => {
    const floor = new RoomNoiseFloor();
    // Speech with brief pauses inside it: alternating loud and room-level
    // chunks throughout. A per-chunk minimum would call this room 250.
    for (let elapsed = 0; elapsed < FULL_WINDOW_MS; elapsed += 100) {
      floor.observe(2_400, 50);
      floor.observe(250, 50);
    }

    expect(floor.floor).toBeCloseTo(1_325, 5);
  });

  test("forgets a room it has left, once the window has rolled", () => {
    const floor = new RoomNoiseFloor();
    feed(floor, 200, FULL_WINDOW_MS);
    expect(floor.floor).toBeCloseTo(200, 5);

    // Walk somewhere loud and stay there past the retention window.
    feed(floor, 900, FULL_WINDOW_MS);

    expect(floor.floor).toBeCloseTo(900, 5);
  });

  test("weights by duration so an odd-sized tail cannot skew a block", () => {
    const floor = new RoomNoiseFloor();
    for (let block = 0; block < NOISE_FLOOR_BLOCK_COUNT; block += 1) {
      floor.observe(100, NOISE_FLOOR_BLOCK_MS - 10);
      floor.observe(10_000, 10);
    }

    // 10ms of a loud tail moves a 1s block by ~1%, not by half.
    expect(floor.floor).toBeCloseTo(
      (100 * (NOISE_FLOOR_BLOCK_MS - 10) + 10_000 * 10) / NOISE_FLOOR_BLOCK_MS,
      5,
    );
  });

  test("interrupt() drops the partial block without losing completed ones", () => {
    const floor = new RoomNoiseFloor();
    feed(floor, 300, FULL_WINDOW_MS);
    // Half a block of near-silence, then playback starts and observation stops.
    feed(floor, 10, NOISE_FLOOR_BLOCK_MS / 2);
    floor.interrupt();
    // Resume after playback; the two halves must not merge into one block that
    // measures neither side of the gap.
    feed(floor, 300, NOISE_FLOOR_BLOCK_MS);

    expect(floor.floor).toBeCloseTo(300, 5);
  });

  test("ignores non-positive durations and non-finite amplitudes", () => {
    const floor = new RoomNoiseFloor();
    floor.observe(500, 0);
    floor.observe(500, -50);
    floor.observe(Number.NaN, 50);

    feed(floor, 300, FULL_WINDOW_MS);
    expect(floor.floor).toBeCloseTo(300, 5);
  });

  test("reset() clears completed blocks too", () => {
    const floor = new RoomNoiseFloor();
    feed(floor, 300, FULL_WINDOW_MS);
    floor.reset();

    expect(floor.floor).toBeNull();
  });
});

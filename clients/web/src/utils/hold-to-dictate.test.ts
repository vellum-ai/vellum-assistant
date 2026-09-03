import { afterEach, describe, expect, test } from "bun:test";

import {
  isHoldDictation,
  markHoldDictation,
} from "@/utils/hold-to-dictate";

afterEach(() => {
  markHoldDictation(false);
});

describe("the hold dictation marker", () => {
  test("is off until a hold marks it", () => {
    expect(isHoldDictation()).toBe(false);

    markHoldDictation(true);
    expect(isHoldDictation()).toBe(true);
  });

  /**
   * The recording is started through an imperative handle on whichever button
   * owns dictation, so the marker is how the session learns what it was begun
   * for. It is read once at the start; clearing it later must not reach back
   * into a session already running.
   */
  test("clears when the hold ends", () => {
    markHoldDictation(true);
    markHoldDictation(false);

    expect(isHoldDictation()).toBe(false);
  });
});

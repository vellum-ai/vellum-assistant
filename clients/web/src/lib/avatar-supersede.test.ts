import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import {
  AVATAR_SUPERSEDE_WINDOW_MS,
  isAvatarSuperseded,
  markAvatarSuperseded,
  resetAvatarSupersedeForTests,
} from "./avatar-supersede";

// Freeze the clock before the first mark, so every `Date.now()` below reads the
// same instant. On the live clock a mark is stamped at the real time and the
// `setSystemTime(Date.now() + …)` that follows adds the milliseconds spent
// getting there on top of the window, which puts the mark outside it as soon as
// the test takes 1 ms.
beforeEach(() => {
  setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  setSystemTime();
  resetAvatarSupersedeForTests();
});

describe("avatar supersede window", () => {
  test("an unmarked id is not superseded", () => {
    expect(isAvatarSuperseded("a")).toBe(false);
  });

  test("a mark holds for the window and expires after it", () => {
    markAvatarSuperseded("a");
    expect(isAvatarSuperseded("a")).toBe(true);
    setSystemTime(new Date(Date.now() + AVATAR_SUPERSEDE_WINDOW_MS - 1));
    expect(isAvatarSuperseded("a")).toBe(true);
    setSystemTime(new Date(Date.now() + 1));
    expect(isAvatarSuperseded("a")).toBe(false);
  });

  test("a later mark restarts the window", () => {
    markAvatarSuperseded("a");
    setSystemTime(new Date(Date.now() + AVATAR_SUPERSEDE_WINDOW_MS - 1));
    markAvatarSuperseded("a");
    setSystemTime(new Date(Date.now() + AVATAR_SUPERSEDE_WINDOW_MS - 1));
    expect(isAvatarSuperseded("a")).toBe(true);
  });
});

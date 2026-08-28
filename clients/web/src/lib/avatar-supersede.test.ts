import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import {
  AVATAR_SUPERSEDE_WINDOW_MS,
  isAvatarSuperseded,
  markAvatarSuperseded,
  resetAvatarSupersedeForTests,
} from "./avatar-supersede";

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

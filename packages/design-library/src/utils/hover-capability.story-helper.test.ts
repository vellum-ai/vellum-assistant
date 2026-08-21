import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { acquireNoHoverMatchMedia } from "./hover-capability.story-helper";
import { HOVER_ABSENT_MEDIA_QUERY } from "./hover-capability";

// Plain bun has no DOM; the helper only touches `window.matchMedia`, so a
// two-property stub is the whole environment it needs.
const stubMatchMedia = (query: string) =>
  ({ media: query, matches: false }) as MediaQueryList;

let hadWindow: boolean;
let savedWindow: unknown;

beforeEach(() => {
  hadWindow = "window" in globalThis;
  savedWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    matchMedia: stubMatchMedia,
  };
});

afterEach(() => {
  if (hadWindow) {
    (globalThis as Record<string, unknown>).window = savedWindow;
  } else {
    delete (globalThis as Record<string, unknown>).window;
  }
});

describe("acquireNoHoverMatchMedia", () => {
  test("answers only the hover query and restores on release", () => {
    const release = acquireNoHoverMatchMedia();

    expect(window.matchMedia(HOVER_ABSENT_MEDIA_QUERY).matches).toBe(true);
    expect(window.matchMedia("(min-width: 100px)").matches).toBe(false);

    release();

    expect(window.matchMedia(HOVER_ABSENT_MEDIA_QUERY).matches).toBe(false);
  });

  test("overlapping leases released in mount order restore the real matchMedia", () => {
    // Two stories on one autodocs page: the second acquire must not capture
    // the first wrapper as its original, or the last release reinstalls it
    // and every later story reports no hover.
    const releaseFirst = acquireNoHoverMatchMedia();
    const releaseSecond = acquireNoHoverMatchMedia();

    releaseFirst();
    expect(window.matchMedia(HOVER_ABSENT_MEDIA_QUERY).matches).toBe(true);

    releaseSecond();
    expect(window.matchMedia(HOVER_ABSENT_MEDIA_QUERY).matches).toBe(false);
  });

  test("a release is idempotent and never double-decrements", () => {
    const releaseFirst = acquireNoHoverMatchMedia();
    const releaseSecond = acquireNoHoverMatchMedia();

    releaseFirst();
    releaseFirst();
    expect(window.matchMedia(HOVER_ABSENT_MEDIA_QUERY).matches).toBe(true);

    releaseSecond();
    expect(window.matchMedia(HOVER_ABSENT_MEDIA_QUERY).matches).toBe(false);
  });
});

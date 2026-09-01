/**
 * Pins what `MIN_VERSION` admits.
 *
 * The constant is a pinned dev-build timestamp, `0.11.7-dev.202609010135`,
 * which looks like a value someone left behind by accident. It is not: `main`
 * carries 0.11.7 as its base, so a build with the `sight_frame` handler and one
 * from before it are both named `0.11.7-dev.*` and only the timestamp separates
 * them. The rows below pin both edges of that separation, and one row each for
 * the two tidier constants that are wrong in opposite directions, so neither
 * edit can land quietly.
 *
 * These assert against `versionSupports` rather than the hook: the hook adds
 * store hydration and owner-scoping, which are `useAssistantScopedSupports`'s
 * concern and already covered by `utils.test.ts`. What is specific to this gate
 * is which VERSIONS pass, so that is what is tested.
 */

import { describe, expect, test } from "bun:test";

import { comparePreRelease } from "@/utils/semver";

import { versionSupports } from "./utils";
import { MIN_VERSION } from "./use-supports-sight-stream";

describe("sight stream version gate", () => {
  test("admits a dev build cut after the handler merged", () => {
    // The row `0.11.8` breaks: a build packaged from `main` today has the
    // handler and reports a 0.11.7 base, so a 0.11.8 floor would leave the
    // feature dark on exactly the builds it was written for.
    expect(
      versionSupports("0.11.7-dev.202609010200.abcdef01", MIN_VERSION),
    ).toBe(true);
  });

  test("admits a dev build stamped in the floor's own minute", () => {
    // The floor names no sha, so this is the segment-count edge: the version
    // has one segment more than the floor and must still clear it.
    expect(
      versionSupports("0.11.7-dev.202609010135.abcdef01", MIN_VERSION),
    ).toBe(true);
  });

  test("excludes a dev build from before the handler merged", () => {
    // The row `0.11.7-dev.0` breaks. The 2026-08-27 cut through the merge is a
    // window of 0.11.7 dev builds with no handler, and a floor that reads as
    // "any dev build of 0.11.7" would send them a frame every few seconds that
    // each one refuses.
    expect(
      versionSupports("0.11.7-dev.202608310000.abcdef01", MIN_VERSION),
    ).toBe(false);
    // The minute before the floor, which is the rounding-up decision itself: a
    // build stamped here may have been computed before the merge landed at
    // 01:34:30Z, so it is refused rather than guessed at.
    expect(
      versionSupports("0.11.7-dev.202609010134.abcdef01", MIN_VERSION),
    ).toBe(false);
  });

  test("excludes the 0.11.7 stable release", () => {
    // Cut 2026-08-27, before the handler existed. Excluded by the `dev` suffix
    // alone, since a dev build outranks its own base's release.
    expect(versionSupports("0.11.7", MIN_VERSION)).toBe(false);
  });

  test("excludes everything below 0.11.7", () => {
    expect(versionSupports("0.11.6", MIN_VERSION)).toBe(false);
    expect(versionSupports("0.10.12", MIN_VERSION)).toBe(false);
    // A later timestamp on an older base is still an older base: the base is
    // compared first and the suffix is never reached.
    expect(
      versionSupports("0.11.6-dev.202609020000.abcdef01", MIN_VERSION),
    ).toBe(false);
  });

  test("admits every higher base, dev builds included", () => {
    expect(versionSupports("0.11.8", MIN_VERSION)).toBe(true);
    expect(
      versionSupports("0.11.8-dev.202609020000.abcdef01", MIN_VERSION),
    ).toBe(true);
    // Guards the string-compare trap: "0.12.0" < "0.11.7" lexically, and only
    // a real numeric comparison gets this right.
    expect(versionSupports("0.12.0", MIN_VERSION)).toBe(true);
    expect(versionSupports("1.0.0", MIN_VERSION)).toBe(true);
  });

  test("stays closed on an unknown or unparseable version", () => {
    expect(versionSupports(null, MIN_VERSION)).toBe(false);
    expect(versionSupports(undefined, MIN_VERSION)).toBe(false);
    expect(versionSupports("not-a-version", MIN_VERSION)).toBe(false);
  });

  test("the comparator orders a sha-bearing build against the bare floor", () => {
    // The property the floor's format rests on, asserted directly rather than
    // inferred from the rows above: where the floor runs out of segments, the
    // version that still has one is the greater. Without it a same-minute build
    // would tie, and a `>= 0` gate would still admit it, but the rounding-up
    // argument would be resting on luck.
    // Asserted rather than assumed, so a floor edited into a plain release
    // fails here with a readable message instead of throwing on the split.
    expect(MIN_VERSION).toMatch(/^\d+\.\d+\.\d+-dev\.\d{12}$/);
    const floorPre = MIN_VERSION.split("-")[1]!;
    expect(
      comparePreRelease("dev.202609010135.abcdef01", floorPre),
    ).toBeGreaterThan(0);
    expect(
      comparePreRelease("dev.202609010200.abcdef01", floorPre),
    ).toBeGreaterThan(0);
    expect(
      comparePreRelease("dev.202608310000.abcdef01", floorPre),
    ).toBeLessThan(0);
  });
});

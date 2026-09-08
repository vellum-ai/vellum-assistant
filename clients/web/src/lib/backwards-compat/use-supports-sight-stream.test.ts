/**
 * Pins what `MIN_VERSION` admits.
 *
 * The constant is one published build's exact version string,
 * `0.11.7-dev.202609010224.44cd29e`, which looks like a value someone left
 * behind by accident. It is not: `main` carries 0.11.7 as its base, so a build
 * with the `sight_frame` handler and one from before it are both named
 * `0.11.7-dev.*` and only the suffix separates them. The rows below pin both
 * edges of that separation, plus one row for each tidier constant that is wrong
 * in a different direction, so none of those edits can land quietly.
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
  test("admits the published build it names", () => {
    // The floor is an artifact, not a boundary, so the artifact itself has to
    // clear it: `versionSupports` compares dev suffixes with `>= 0`, and equal
    // strings compare 0.
    expect(versionSupports(MIN_VERSION, MIN_VERSION)).toBe(true);
  });

  test("admits a dev build published after it", () => {
    // A handler-bearing dev build reports the floor's own base, so a floor at
    // the next stable base would leave the feature dark on exactly the builds
    // that carry the handler.
    expect(
      versionSupports("0.11.7-dev.202609010300.abcdef01", MIN_VERSION),
    ).toBe(true);
    expect(
      versionSupports("0.11.7-dev.202609010225.abcdef01", MIN_VERSION),
    ).toBe(true);
  });

  test("excludes a handler-less build stamped after the floor's minute", () => {
    // Dev versions are stamped when the release workflow computes them, not
    // when the run was dispatched, so a handler-less build can carry a stamp
    // later than the floor's minute. A bare-minute floor admits it on the
    // extra-segment rule; a floor naming a whole published build does not.
    expect(
      versionSupports("0.11.7-dev.202609010140.deadbee", MIN_VERSION),
    ).toBe(false);
  });

  test("excludes a dev build from before the handler merged", () => {
    // Handler-less dev builds share the floor's base, so a floor that reads
    // as "any dev build of this base" would send them a frame every few
    // seconds that each one refuses.
    expect(
      versionSupports("0.11.7-dev.202608310000.abcdef01", MIN_VERSION),
    ).toBe(false);
    // Builds stamped just below the floor's minute are excluded by the
    // timestamp comparison alone.
    expect(
      versionSupports("0.11.7-dev.202609010134.abcdef01", MIN_VERSION),
    ).toBe(false);
    expect(
      versionSupports("0.11.7-dev.202609010135.abcdef01", MIN_VERSION),
    ).toBe(false);
  });

  test("excludes the 0.11.7 stable release", () => {
    // The same-base stable release predates the handler. Excluded by the
    // `dev` suffix alone, since a dev build outranks its own base's release.
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

  test("the floor is a whole build version, timestamp and sha", () => {
    // Asserted rather than assumed, so a floor edited into a plain release or
    // back to a bare minute fails here with a readable message instead of
    // silently changing which builds the gate trusts.
    expect(MIN_VERSION).toMatch(/^\d+\.\d+\.\d+-dev\.\d{12}\.[0-9a-f]+$/);
  });

  test("the comparator orders dev suffixes by timestamp, then by sha", () => {
    // The mechanics the rows above rest on, asserted directly. The last pair
    // is the residual ambiguity written down: a second run stamped in this
    // same minute would be ordered by a lexical sha comparison that means
    // nothing. No such run exists, which is why the floor names an artifact.
    const floorPre = MIN_VERSION.split("-")[1]!;
    expect(
      comparePreRelease("dev.202609010300.abcdef01", floorPre),
    ).toBeGreaterThan(0);
    expect(
      comparePreRelease("dev.202609010140.deadbee", floorPre),
    ).toBeLessThan(0);
    expect(comparePreRelease(floorPre, floorPre)).toBe(0);
    expect(
      comparePreRelease("dev.202609010224.ffffffff", floorPre),
    ).toBeGreaterThan(0);
    expect(
      comparePreRelease("dev.202609010224.00000000", floorPre),
    ).toBeLessThan(0);
  });
});

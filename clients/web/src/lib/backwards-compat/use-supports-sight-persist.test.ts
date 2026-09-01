/**
 * Pins what this gate admits, and the comparator behavior a pinned floor rests
 * on.
 *
 * `MIN_VERSION` is the open placeholder, which admits every version an
 * assistant can report, so the rows that pin a floor's edges are written
 * against `PINNED_SHAPE`, a synthetic constant of the shape a pinned floor has.
 * They are the wiring `useSupportsSightPersist` inherits from
 * `versionSupports`, and they hold whatever the constant is edited to. What is
 * asserted against `MIN_VERSION` itself is only what holds on both sides of
 * pinning.
 *
 * These assert against `versionSupports` rather than the hook: the hook adds
 * store hydration and owner-scoping, which are `useAssistantScopedSupports`'s
 * concern and already covered by `utils.test.ts`. What is specific to this gate
 * is which VERSIONS pass, so that is what is tested.
 */

import { describe, expect, test } from "bun:test";

import { comparePreRelease } from "@/utils/semver";

import { versionSupports } from "./utils";
import { MIN_VERSION } from "./use-supports-sight-persist";

/**
 * A floor of the shape a pinned one has: a base, a dev stamp, a short sha. Not
 * this gate's floor, and not required to be: these rows pin the comparison a
 * whole-build floor gets, which is what the pinned constant will be read
 * through.
 */
const PINNED_SHAPE = "0.11.7-dev.202609010224.44cd29e";

/** The shape a pinned floor has to match. */
const FLOOR_SHAPE = /^\d+\.\d+\.\d+-dev\.\d{12}\.[0-9a-f]+$/;

describe("sight persist version gate", () => {
  test("stays closed on an unknown or unparseable version", () => {
    // True of the placeholder and of any floor that replaces it: an assistant
    // whose version has not hydrated is not one this gate writes to.
    expect(versionSupports(null, MIN_VERSION)).toBe(false);
    expect(versionSupports(undefined, MIN_VERSION)).toBe(false);
    expect(versionSupports("not-a-version", MIN_VERSION)).toBe(false);
  });

  test("admits a version far above any floor", () => {
    // The one positive row the constant itself can carry while it is unpinned:
    // a base this high clears the placeholder and every floor that could
    // replace it. It says the wrapper reaches the comparator at all, which a
    // constant the comparator cannot parse would fail silently.
    expect(versionSupports("99.99.99", MIN_VERSION)).toBe(true);
  });

  test("admits the published build a floor names", () => {
    // A whole-build floor is an artifact, not a boundary, so the artifact
    // itself has to clear it: `versionSupports` compares dev suffixes with
    // `>= 0`, and equal strings compare 0.
    expect(versionSupports(PINNED_SHAPE, PINNED_SHAPE)).toBe(true);
  });

  test("admits a dev build published after the floor", () => {
    // A route-bearing dev build reports the floor's own base, so a floor at the
    // next stable base would leave the feature dark on exactly the builds that
    // carry the route.
    expect(
      versionSupports("0.11.7-dev.202609010300.abcdef01", PINNED_SHAPE),
    ).toBe(true);
    expect(
      versionSupports("0.11.7-dev.202609010225.abcdef01", PINNED_SHAPE),
    ).toBe(true);
  });

  test("excludes a route-less build stamped after the floor's minute", () => {
    // Dev versions are stamped when the release workflow computes them, not
    // when the run was dispatched, so a route-less build can carry a stamp
    // later than the floor's minute. A bare-minute floor admits it on the
    // extra-segment rule; a floor naming a whole published build does not.
    expect(
      versionSupports("0.11.7-dev.202609010140.deadbee", PINNED_SHAPE),
    ).toBe(false);
  });

  test("excludes a dev build from before the floor", () => {
    // Route-less dev builds share the floor's base, so a floor that reads as
    // "any dev build of this base" would upload a frame every few seconds that
    // each one answers with a 404.
    expect(
      versionSupports("0.11.7-dev.202608310000.abcdef01", PINNED_SHAPE),
    ).toBe(false);
    expect(
      versionSupports("0.11.7-dev.202609010223.abcdef01", PINNED_SHAPE),
    ).toBe(false);
  });

  test("excludes the same-base stable release", () => {
    // The same-base stable release predates the route. Excluded by the `dev`
    // suffix alone, since a dev build outranks its own base's release.
    expect(versionSupports("0.11.7", PINNED_SHAPE)).toBe(false);
  });

  test("excludes every lower base", () => {
    expect(versionSupports("0.11.6", PINNED_SHAPE)).toBe(false);
    expect(versionSupports("0.10.12", PINNED_SHAPE)).toBe(false);
    // A later timestamp on an older base is still an older base: the base is
    // compared first and the suffix is never reached.
    expect(
      versionSupports("0.11.6-dev.202609020000.abcdef01", PINNED_SHAPE),
    ).toBe(false);
  });

  test("admits every higher base, dev builds included", () => {
    expect(versionSupports("0.11.8", PINNED_SHAPE)).toBe(true);
    expect(
      versionSupports("0.11.8-dev.202609020000.abcdef01", PINNED_SHAPE),
    ).toBe(true);
    // Guards the string-compare trap: "0.12.0" < "0.11.7" lexically, and only a
    // real numeric comparison gets this right.
    expect(versionSupports("0.12.0", PINNED_SHAPE)).toBe(true);
    expect(versionSupports("1.0.0", PINNED_SHAPE)).toBe(true);
  });

  test("orders dev suffixes by timestamp, then by sha", () => {
    // The mechanics the rows above rest on, asserted directly. The last pair is
    // the residual ambiguity written down: a second run stamped in the same
    // minute ties on the timestamp and falls through to a lexical sha
    // comparison that means nothing in that order. Naming a build that exists
    // is what keeps that hypothetical.
    const floorPre = PINNED_SHAPE.split("-")[1]!;
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

  // Todo while `MIN_VERSION` is the placeholder, which is not a build string
  // and does not match. Turn it into a `test` in the same edit that pins the
  // floor: from then on it is what stops the constant being edited into a plain
  // release or a bare minute, each of which trusts the wrong set of builds.
  test.todo("the floor is a whole build version, timestamp and sha", () => {
    expect(MIN_VERSION).toMatch(FLOOR_SHAPE);
  });
});

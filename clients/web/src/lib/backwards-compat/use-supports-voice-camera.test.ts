/**
 * Pins what `MIN_VERSION` admits.
 *
 * The constant is `0.11.2-dev.0`, a pre-release, which is not the obvious
 * shape for a minimum-version gate and is easy to "tidy" into a plain
 * `0.11.2` by someone who reads it as a typo. That edit would silently offer
 * the camera to every assistant on the released 0.11.2, where the daemon has
 * no `attach_image` handler and refuses every photo.
 *
 * These assert against `versionSupports` rather than the hook: the hook adds
 * store hydration and owner-scoping, which are `useAssistantScopedSupports`'s
 * concern and already covered by `utils.test.ts`. What is specific to this
 * gate is which VERSIONS pass, so that is what is tested.
 */

import { describe, expect, test } from "bun:test";

import { versionSupports } from "./utils";
import { MIN_VERSION } from "./use-supports-voice-camera";

describe("voice camera version gate", () => {
  test("admits a dev build of the release it was cut against", () => {
    // The reason for the pre-release suffix. A dev build carries unreleased
    // commits on top of 0.11.2, including the camera, so it must pass before
    // 0.11.3 exists.
    expect(
      versionSupports("0.11.2-dev.202608061530.5cf8576", MIN_VERSION),
    ).toBe(true);
  });

  test("excludes the 0.11.2 stable release", () => {
    // Cut 2026-08-04 without the frame. This is the row that makes the
    // pre-release suffix necessary rather than decorative.
    expect(versionSupports("0.11.2", MIN_VERSION)).toBe(false);
  });

  test("excludes everything below 0.11.2", () => {
    expect(versionSupports("0.11.1", MIN_VERSION)).toBe(false);
    expect(versionSupports("0.10.12", MIN_VERSION)).toBe(false);
    // A dev build of an older base is still an older base.
    expect(
      versionSupports("0.11.1-dev.202608061530.5cf8576", MIN_VERSION),
    ).toBe(false);
  });

  test("admits the release it ships in and everything after", () => {
    expect(versionSupports("0.11.3", MIN_VERSION)).toBe(true);
    expect(versionSupports("0.11.4", MIN_VERSION)).toBe(true);
    // Guards the string-compare trap: "0.12.0" < "0.11.2" lexically, and only
    // a real numeric comparison gets this right.
    expect(versionSupports("0.12.0", MIN_VERSION)).toBe(true);
    expect(versionSupports("1.0.0", MIN_VERSION)).toBe(true);
  });

  test("stays closed on an unknown or unparseable version", () => {
    expect(versionSupports(null, MIN_VERSION)).toBe(false);
    expect(versionSupports(undefined, MIN_VERSION)).toBe(false);
    expect(versionSupports("not-a-version", MIN_VERSION)).toBe(false);
  });
});

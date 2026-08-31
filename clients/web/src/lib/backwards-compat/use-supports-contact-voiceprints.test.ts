/**
 * Pins what `MIN_VERSION` admits.
 *
 * The constant is `0.11.7-dev.0`, a pre-release, which is not the obvious
 * shape for a minimum-version gate and is easy to "tidy" into a plain
 * `0.11.7`. That edit would mount the voice profile card against every
 * assistant on the released 0.11.7, which has no voiceprint routes, so the
 * list query would 404 into an empty-enrollment card and the clips a user
 * then records would be thrown away by a 404 on the enroll POST.
 *
 * These assert against `versionSupports` rather than the hook: the hook adds
 * store hydration and owner-scoping, which are `useAssistantScopedSupports`'s
 * concern and already covered by `utils.test.ts`. What is specific to this
 * gate is which VERSIONS pass, so that is what is tested.
 */

import { describe, expect, test } from "bun:test";

import { MIN_VERSION } from "./use-supports-contact-voiceprints";
import { versionSupports } from "./utils";

describe("contact voiceprint version gate", () => {
  test("admits a dev build of the release it was cut against", () => {
    // The reason for the pre-release suffix. A dev build carries unreleased
    // commits on top of 0.11.7, including the routes, so it must pass before
    // 0.11.8 exists.
    expect(
      versionSupports("0.11.7-dev.202608311330.4861086", MIN_VERSION),
    ).toBe(true);
  });

  test("excludes the 0.11.7 stable release", () => {
    // Cut 2026-08-27, before the routes landed. This is the row that makes
    // the pre-release suffix necessary rather than decorative.
    expect(versionSupports("0.11.7", MIN_VERSION)).toBe(false);
  });

  test("excludes everything below 0.11.7", () => {
    expect(versionSupports("0.11.6", MIN_VERSION)).toBe(false);
    expect(versionSupports("0.10.12", MIN_VERSION)).toBe(false);
    // A dev build of an older base is still an older base.
    expect(
      versionSupports("0.11.6-dev.202608311330.4861086", MIN_VERSION),
    ).toBe(false);
  });

  test("admits the release it ships in and everything after", () => {
    expect(versionSupports("0.11.8", MIN_VERSION)).toBe(true);
    // Guards the string-compare trap: "0.12.0" < "0.11.7" lexically, and only
    // a real numeric comparison gets this right.
    expect(versionSupports("0.12.0", MIN_VERSION)).toBe(true);
    expect(versionSupports("1.0.0", MIN_VERSION)).toBe(true);
  });

  test("stays closed on an unknown or unparseable version", () => {
    // The card is write-bearing, so the conservative default has to be off.
    expect(versionSupports(null, MIN_VERSION)).toBe(false);
    expect(versionSupports(undefined, MIN_VERSION)).toBe(false);
    expect(versionSupports("not-a-version", MIN_VERSION)).toBe(false);
  });
});

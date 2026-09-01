/**
 * Pins what `MIN_VERSION` admits.
 *
 * The constant is `0.11.8`: a base one past the release this shipped against,
 * and bare where the sibling camera gates carry a `-dev.0` suffix. Both halves
 * look like slips and neither is, so the rows below pin what each one buys.
 * Lowering the base to 0.11.7 admits the dev builds that predate the daemon
 * handler, which refuse every keep while the room's thumbnail says the call can
 * see it. Adding the suffix back turns the feature OFF on the release it ships
 * in, which is the row that catches that edit.
 *
 * These assert against `versionSupports` rather than the hook: the hook adds
 * store hydration and owner-scoping, which are `useAssistantScopedSupports`'s
 * concern and already covered by `utils.test.ts`. What is specific to this gate
 * is which VERSIONS pass, so that is what is tested.
 */

import { describe, expect, test } from "bun:test";

import { versionSupports } from "./utils";
import { MIN_VERSION } from "./use-supports-sight-stream";

describe("sight stream version gate", () => {
  test("excludes every 0.11.7 build, dev ones included", () => {
    // Why the base is one past the release this was written against. `main`
    // carries 0.11.7, so a dev build with the handler and one without are
    // named alike and neither can be admitted.
    expect(versionSupports("0.11.7", MIN_VERSION)).toBe(false);
    expect(
      versionSupports("0.11.7-dev.202608311412.b432fb7", MIN_VERSION),
    ).toBe(false);
  });

  test("excludes everything below 0.11.7", () => {
    expect(versionSupports("0.11.6", MIN_VERSION)).toBe(false);
    expect(versionSupports("0.10.12", MIN_VERSION)).toBe(false);
  });

  test("admits the release it ships in", () => {
    // The row that fails if anyone appends `-dev.0` for symmetry with the
    // sibling gates: a dev build counts as newer than its own base's release,
    // so a `0.11.8-dev.0` floor would exclude 0.11.8 itself.
    expect(versionSupports("0.11.8", MIN_VERSION)).toBe(true);
  });

  test("admits a dev build of the base that carries the frame", () => {
    // Exercisable on a build from `main` the day its base bumps, without
    // waiting for 0.11.8 stable to exist.
    expect(
      versionSupports("0.11.8-dev.202609011412.b432fb7", MIN_VERSION),
    ).toBe(true);
  });

  test("admits everything after", () => {
    // Guards the string-compare trap: "0.12.0" < "0.11.8" lexically, and only
    // a real numeric comparison gets this right.
    expect(versionSupports("0.11.9", MIN_VERSION)).toBe(true);
    expect(versionSupports("0.12.0", MIN_VERSION)).toBe(true);
    expect(versionSupports("1.0.0", MIN_VERSION)).toBe(true);
  });

  test("stays closed on an unknown or unparseable version", () => {
    expect(versionSupports(null, MIN_VERSION)).toBe(false);
    expect(versionSupports(undefined, MIN_VERSION)).toBe(false);
    expect(versionSupports("not-a-version", MIN_VERSION)).toBe(false);
  });
});

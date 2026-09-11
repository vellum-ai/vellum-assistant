import { describe, expect, test } from "bun:test";

import {
  FN_CLAIMANT_BUNDLE_IDS,
  FN_CLAIMANT_QUIT_BUNDLE_IDS,
  FN_CLAIMANTS,
} from "./fn-claimants";

describe("the voice key's claimants", () => {
  test("every claimant can be asked about", () => {
    expect(FN_CLAIMANT_BUNDLE_IDS).toEqual(FN_CLAIMANTS.map((a) => a.bundleId));
  });

  /**
   * Quitting is the one thing the renderer can do to another app. A keyboard
   * tool holds the key because the user set it to, so only the dictation app
   * that types on the same hold is offered the door.
   */
  test("only Wispr Flow is offered a quit", () => {
    expect(FN_CLAIMANT_QUIT_BUNDLE_IDS).toEqual(["com.electron.wispr-flow"]);
  });

  test("bundle identifiers are unique", () => {
    expect(new Set(FN_CLAIMANT_BUNDLE_IDS).size).toBe(
      FN_CLAIMANT_BUNDLE_IDS.length,
    );
  });
});

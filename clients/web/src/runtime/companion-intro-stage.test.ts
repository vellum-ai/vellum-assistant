/**
 * Tests for the held answer to "is a run on right now".
 *
 * The reader that matters is a function call inside a keypress, so what is
 * under test is that the answer is already here when it asks: followed from
 * import, seeded by the pull main answers, and kept current by the pushes.
 *
 * The module follows the bridge once, at import, so the cases run in order
 * against that one subscription rather than re-mounting anything.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => true,
}));

/** Main's listeners, so a case can push a change the way the shell would. */
const pushes: ((staged: boolean) => void)[] = [];

/**
 * What the pull answers: a run that was already on before this window loaded,
 * which is what a reload mid-run looks like.
 */
const stagedOnLoad = true;

window.vellum = {
  companion: {
    getState: async () => null,
    onState: () => () => undefined,
    getIntroStage: async () => stagedOnLoad,
    onIntroStage: (callback: (staged: boolean) => void) => {
      pushes.push(callback);
      return () => {
        pushes.splice(pushes.indexOf(callback), 1);
      };
    },
  },
} as unknown as Window["vellum"];

const { companionIntroStaged } =
  await import("@/runtime/companion-intro-stage");

const push = (staged: boolean): void => {
  for (const callback of [...pushes]) {
    callback(staged);
  }
};

describe("companionIntroStaged", () => {
  test("subscribes from import, without waiting to be mounted", () => {
    expect(pushes.length).toBe(1);
  });

  /**
   * First, because it is the state the module loaded into. A run can start
   * while this window is loading and the window can reload mid-run, so the
   * push that would have said so has already been and gone.
   */
  test("a run already on when the module loads is carried in", async () => {
    // The pull is a promise resolved on the microtask queue, so let it land.
    await Promise.resolve();
    await Promise.resolve();

    expect(companionIntroStaged()).toBe(true);
  });

  test("follows main's pushes both ways", () => {
    push(false);
    expect(companionIntroStaged()).toBe(false);

    push(true);
    expect(companionIntroStaged()).toBe(true);

    push(false);
    expect(companionIntroStaged()).toBe(false);
  });
});

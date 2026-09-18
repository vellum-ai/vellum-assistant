/**
 * The one thing the held answer has to get right that a second case in
 * `companion-intro-stage.test.ts` could not reach: what the module loads into.
 *
 * It follows main once and asks main once, at import, so a file gets one of
 * each. That file spends its pair on the ordinary case, where the ask answers
 * first and seeds the run it found. This one spends its pair on the race: a
 * push landing while the ask is still out.
 *
 * It matters more than the odds suggest. The ask describes the moment it went
 * out and nothing will correct it, so an ask that wins on arrival pins the
 * answer to a run that is over, and every later voice entry reads itself as
 * part of the introduction: no first-run card, ever again, on that install.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => true,
}));

/** Main's listener, kept so the case can push the way the shell would. */
const pushes: ((staged: boolean) => void)[] = [];

/** The ask, answered by hand so a push can be made to land inside it. */
let answerAsk: (staged: boolean) => void = () => undefined;
const ask = new Promise<boolean>((resolve) => {
  answerAsk = resolve;
});

window.vellum = {
  companion: {
    getState: async () => null,
    onState: () => () => undefined,
    getIntroStage: () => ask,
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

describe("an ask overtaken by a push", () => {
  test("the push is the answer, and the stale ask is dropped", async () => {
    // The run ends while the ask is in flight. This is the only `false` main
    // will send, because the run it belonged to is over.
    push(false);
    expect(companionIntroStaged()).toBe(false);

    // The ask now answers with what was true when it went out.
    answerAsk(true);
    await ask;
    await Promise.resolve();

    expect(companionIntroStaged()).toBe(false);
  });

  test("and pushes after it still land", () => {
    push(true);
    expect(companionIntroStaged()).toBe(true);

    push(false);
    expect(companionIntroStaged()).toBe(false);
  });
});

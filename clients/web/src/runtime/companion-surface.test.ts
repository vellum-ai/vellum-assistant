import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CompanionContext } from "@vellumai/ipc-contract";

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => true,
}));

const { setCompanionContext, clearCompanionWorking } = await import(
  "./companion-surface"
);

const sent: CompanionContext[] = [];

beforeEach(() => {
  sent.length = 0;
  window.vellum = {
    companion: {
      getState: async () => null,
      onState: () => () => undefined,
      setContext: (context: CompanionContext) => {
        sent.push(context);
      },
    },
  } as unknown as Window["vellum"];
  // Whatever an earlier case left behind, so each starts from a known context.
  setCompanionContext({ assistantName: "Ziggy", turns: [], working: false });
  sent.length = 0;
});

afterEach(() => {
  delete (window as { vellum?: unknown }).vellum;
});

const WORKING: CompanionContext = {
  assistantName: "Ziggy",
  turns: [{ role: "user", text: "hello" }],
  working: true,
};

/**
 * Main holds the last context it was given so the card survives the surface's
 * renderer reloading. The tail is worth holding that way and the flag is not:
 * it is a claim about right now, and a publisher going away does not make it
 * true. Nothing else can correct it, since the surface is opened by a feature
 * flag and the tray preference rather than by the window publishing to it.
 */
describe("clearCompanionWorking", () => {
  test("says nothing when no turn was ever claimed", () => {
    clearCompanionWorking();
    expect(sent).toEqual([]);
  });

  test("says nothing when the last context was already idle", () => {
    setCompanionContext({ assistantName: "Ziggy", turns: [], working: false });
    sent.length = 0;

    clearCompanionWorking();

    expect(sent).toEqual([]);
  });

  test("publishes the claim being given up", () => {
    setCompanionContext(WORKING);
    sent.length = 0;

    clearCompanionWorking();

    expect(sent.at(-1)?.working).toBe(false);
  });

  /**
   * The tail is a record of what was said and the surface is still where it is
   * read, so giving up the claim must not blank the card with it.
   */
  test("leaves the conversation and the name standing", () => {
    setCompanionContext(WORKING);
    sent.length = 0;

    clearCompanionWorking();

    expect(sent.at(-1)?.turns).toEqual(WORKING.turns);
    expect(sent.at(-1)?.assistantName).toBe("Ziggy");
  });

  test("is idempotent, so a logout after an unmount adds nothing", () => {
    setCompanionContext(WORKING);
    clearCompanionWorking();
    sent.length = 0;

    clearCompanionWorking();

    expect(sent).toEqual([]);
  });

  test("claims again once a later turn says so", () => {
    setCompanionContext(WORKING);
    clearCompanionWorking();
    setCompanionContext(WORKING);
    sent.length = 0;

    clearCompanionWorking();

    expect(sent.at(-1)?.working).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CompanionContext } from "@vellumai/ipc-contract";

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => true,
}));

const { setCompanionContext, clearCompanionWorking, setCompanionDictation } =
  await import("./companion-surface");

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
  setCompanionContext({ assistantName: "Ziggy", working: false });
  sent.length = 0;
});

afterEach(() => {
  delete (window as { vellum?: unknown }).vellum;
});

const WORKING: CompanionContext = {
  assistantName: "Ziggy",
  working: true,
};

/**
 * Main holds the last context it was given so the surface survives its own
 * renderer reloading. The name is worth holding that way and the flag is not:
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
    setCompanionContext({ assistantName: "Ziggy", working: false });
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
   * The name is a record of whose surface this is and the surface is still on
   * screen, so giving up the claim must not blank it with it.
   */
  test("leaves the name standing", () => {
    setCompanionContext(WORKING);
    sent.length = 0;

    clearCompanionWorking();

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

describe("setCompanionDictation", () => {
  /**
   * A recogniser revises its guess several times a second, and each revision
   * is a fact about the microphone rather than about the assistant. What was
   * published beside it must survive being corrected in place.
   */
  test("keeps the context it was published beside", () => {
    setCompanionContext({ assistantName: "Ziggy", working: true });
    sent.length = 0;

    setCompanionDictation("listening", "the quick brown");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.dictationText).toBe("the quick brown");
    expect(sent[0]?.dictating).toBe("listening");
    expect(sent[0]?.assistantName).toBe("Ziggy");
    expect(sent[0]?.working).toBe(true);
  });

  /** Words that did not move are not news, and this runs per recognition. */
  test("says nothing when neither the phase nor the words moved", () => {
    setCompanionDictation("listening", "the quick brown");
    sent.length = 0;

    setCompanionDictation("listening", "the quick brown");

    expect(sent).toHaveLength(0);
  });

  test("publishes the end of the dictation", () => {
    setCompanionDictation("listening", "the quick brown");
    sent.length = 0;

    setCompanionDictation(undefined, "");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.dictating).toBeUndefined();
    expect(sent[0]?.dictationText).toBe("");
  });

  /**
   * There is nothing to correct before a context exists, and a dictation with
   * no assistant beside it is not a card the surface draws.
   */
  test("stays silent before any context has been published", async () => {
    delete (window as { vellum?: unknown }).vellum;
    const fresh = await import(`./companion-surface?fresh=${Date.now()}`);
    const seen: CompanionContext[] = [];
    window.vellum = {
      companion: {
        getState: async () => null,
        onState: () => () => undefined,
        setContext: (context: CompanionContext) => {
          seen.push(context);
        },
      },
    } as unknown as Window["vellum"];

    fresh.setCompanionDictation("listening", "hello");

    expect(seen).toHaveLength(0);
  });
});

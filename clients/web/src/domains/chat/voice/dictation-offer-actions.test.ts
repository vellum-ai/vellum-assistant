import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@/runtime/input-activity", () => ({
  setInputActivityWatch: async () => true,
  subscribeToInputActivity: () => () => {},
}));

import { answerDictationOffer } from "@/domains/chat/voice/dictation-offer-actions";
import {
  clearDictationOffer,
  setDictationOffer,
  setUnplacedDictationOffer,
  useDictationOfferStore,
} from "@/domains/chat/voice/dictation-offer-store";

const WISPR = { bundleId: "com.electron.wispr-flow", name: "Wispr Flow" };

function deps(front: string | null) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      frontmostApp: async () => front,
      quitApp: async (bundleId: string) => {
        calls.push(`quit ${bundleId}`);
        return true;
      },
      undoInFrontApp: async () => {
        calls.push("undo");
        return { status: "inserted" as const };
      },
      insertTextIntoFrontApp: async (text: string) => {
        calls.push(`insert ${text}`);
        return { status: "inserted" as const };
      },
    },
  };
}

/**
 * The offer standing right now, which is what a press on its card names. The
 * ids are minted inside the store, so a case reads one back rather than
 * choosing it.
 */
function standingId(): string {
  const { offer } = useDictationOfferStore.getState();
  if (offer === null) {
    throw new Error("Expected an offer to be standing");
  }
  return offer.id;
}

afterEach(() => {
  clearDictationOffer();
});

describe("answering the dictation offer", () => {
  test("use undoes the other app's paste and inserts Vellum's words", async () => {
    setDictationOffer(WISPR, "Send me the files.", "com.example.editor");
    const d = deps("com.example.editor");
    expect(await answerDictationOffer("use", standingId(), d.deps)).toBe(
      "replaced",
    );
    expect(d.calls).toEqual(["undo", "insert Send me the files."]);
    expect(useDictationOfferStore.getState().offer).toBeNull();
  });

  /**
   * The undo goes to whatever is in front. An application the user has moved
   * to since would lose an edit of its own, so nothing is touched.
   */
  test("use does nothing once the user has left the application", async () => {
    setDictationOffer(WISPR, "Send me the files.", "com.example.editor");
    const d = deps("com.example.browser");
    expect(await answerDictationOffer("use", standingId(), d.deps)).toBe(
      "moved-on",
    );
    expect(d.calls).toEqual([]);
    expect(useDictationOfferStore.getState().offer).toBeNull();
  });

  test("use still acts when the front application was never known", async () => {
    setDictationOffer(WISPR, "words", null);
    const d = deps("com.example.editor");
    expect(await answerDictationOffer("use", standingId(), d.deps)).toBe(
      "replaced",
    );
  });

  test("quit asks the other app to quit and nothing else", async () => {
    setDictationOffer(WISPR, "words", "com.example.editor");
    const d = deps("com.example.editor");
    expect(await answerDictationOffer("quit", standingId(), d.deps)).toBe(
      "quit",
    );
    expect(d.calls).toEqual(["quit com.electron.wispr-flow"]);
  });

  test("dismiss takes the offer down and touches nothing", async () => {
    setDictationOffer(WISPR, "words", "com.example.editor");
    const d = deps("com.example.editor");
    expect(await answerDictationOffer("dismiss", standingId(), d.deps)).toBe(
      "dismissed",
    );
    expect(d.calls).toEqual([]);
    expect(useDictationOfferStore.getState().offer).toBeNull();
  });

  /**
   * The clipboard write is main's, done before the command reaches this side.
   * All that is left here is to stop offering the words.
   */
  test("copy takes the offer down and touches no application", async () => {
    setUnplacedDictationOffer("onions, tomatoes, and a bag of rice");
    const d = deps("com.example.editor");
    expect(await answerDictationOffer("copy", standingId(), d.deps)).toBe(
      "copied",
    );
    expect(d.calls).toEqual([]);
    expect(useDictationOfferStore.getState().offer).toBeNull();
  });

  /**
   * The card picks its answers from the offer's reason, so the only way to
   * see one that does not belong is a press racing an offer that has since
   * been replaced. Nothing is acted on: there is no paste of another app's to
   * undo when none claimed the key.
   */
  test("an answer the standing offer cannot honour is a dismissal", async () => {
    setUnplacedDictationOffer("onions, tomatoes, and a bag of rice");
    const d = deps("com.example.editor");
    expect(await answerDictationOffer("use", standingId(), d.deps)).toBe(
      "dismissed",
    );
    expect(d.calls).toEqual([]);
    expect(useDictationOfferStore.getState().offer).toBeNull();
  });

  test("an answer with no offer standing is nothing", async () => {
    const d = deps("com.example.editor");
    const quit = mock(d.deps.quitApp);
    expect(
      await answerDictationOffer("use", "offer-1", {
        ...d.deps,
        quitApp: quit,
      }),
    ).toBe("none");
    expect(d.calls).toEqual([]);
  });

  /**
   * The surface can be a frame behind this window, so a press can arrive
   * after a new hold has put different words up. Acting on it would answer a
   * question the user was never asked with words they never read, and would
   * take down an offer they have not seen yet.
   */
  test("a press naming an offer that has been replaced is dropped", async () => {
    setDictationOffer(WISPR, "first", "com.example.editor");
    const stale = standingId();
    setUnplacedDictationOffer("second");
    const d = deps("com.example.editor");

    expect(await answerDictationOffer("copy", stale, d.deps)).toBe("stale");

    expect(d.calls).toEqual([]);
    expect(useDictationOfferStore.getState().offer).toMatchObject({
      text: "second",
    });
  });
});

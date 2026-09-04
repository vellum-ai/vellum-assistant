import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@/runtime/input-activity", () => ({
  setInputActivityWatch: async () => true,
  subscribeToInputActivity: () => () => {},
}));

import { answerDictationOffer } from "@/domains/chat/voice/dictation-offer-actions";
import {
  clearDictationOffer,
  setDictationOffer,
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

afterEach(() => {
  clearDictationOffer();
});

describe("answering the dictation offer", () => {
  test("use undoes the other app's paste and inserts Vellum's words", async () => {
    setDictationOffer(WISPR, "Send me the files.", "com.example.editor");
    const d = deps("com.example.editor");
    expect(await answerDictationOffer("use", d.deps)).toBe("replaced");
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
    expect(await answerDictationOffer("use", d.deps)).toBe("moved-on");
    expect(d.calls).toEqual([]);
    expect(useDictationOfferStore.getState().offer).toBeNull();
  });

  test("use still acts when the front application was never known", async () => {
    setDictationOffer(WISPR, "words", null);
    const d = deps("com.example.editor");
    expect(await answerDictationOffer("use", d.deps)).toBe("replaced");
  });

  test("quit asks the other app to quit and nothing else", async () => {
    setDictationOffer(WISPR, "words", "com.example.editor");
    const d = deps("com.example.editor");
    expect(await answerDictationOffer("quit", d.deps)).toBe("quit");
    expect(d.calls).toEqual(["quit com.electron.wispr-flow"]);
  });

  test("dismiss takes the offer down and touches nothing", async () => {
    setDictationOffer(WISPR, "words", "com.example.editor");
    const d = deps("com.example.editor");
    expect(await answerDictationOffer("dismiss", d.deps)).toBe("dismissed");
    expect(d.calls).toEqual([]);
    expect(useDictationOfferStore.getState().offer).toBeNull();
  });

  test("an answer with no offer standing is nothing", async () => {
    const d = deps("com.example.editor");
    const quit = mock(d.deps.quitApp);
    expect(
      await answerDictationOffer("use", { ...d.deps, quitApp: quit }),
    ).toBe("none");
    expect(d.calls).toEqual([]);
  });
});

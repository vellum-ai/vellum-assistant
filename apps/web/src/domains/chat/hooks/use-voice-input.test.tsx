import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Dispatch, RefObject, SetStateAction } from "react";

type TextInsertionStatus =
  | "inserted"
  | "vellum-focused"
  | "automation-denied"
  | "blocked"
  | "unavailable";

let nextTextInsertionStatus: TextInsertionStatus = "unavailable";
const insertedTexts: string[] = [];

mock.module("@/runtime/text-insertion", () => ({
  insertTextIntoFrontApp: async (text: string) => {
    insertedTexts.push(text);
    return { status: nextTextInsertionStatus };
  },
  openTextInsertionSettings: async () => undefined,
}));

mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: () => false,
}));

mock.module("@/domains/chat/components/mic-permission-primer", () => ({
  shouldShowMicPrimer: () => false,
}));

mock.module("@/domains/chat/voice/dictation-api", () => ({
  postDictation: async () => null,
}));

mock.module("@/domains/chat/voice/push-to-talk-host", () => ({
  shouldEnablePushToTalk: () => false,
}));

mock.module("@/domains/chat/voice/use-push-to-talk", () => ({
  usePushToTalk: () => undefined,
}));

const { useVoiceInput } = await import("./use-voice-input");

const renderVoiceInput = () => {
  let input = "";
  let focusCount = 0;
  const setInput: Dispatch<SetStateAction<string>> = (value) => {
    input = typeof value === "function" ? value(input) : value;
  };
  const inputRef = {
    current: {
      selectionStart: null,
      focus: () => {
        focusCount += 1;
      },
    } as unknown as HTMLTextAreaElement,
  } satisfies RefObject<HTMLTextAreaElement | null>;

  const hook = renderHook(() =>
    useVoiceInput({ assistantId: null, inputRef, setInput }),
  );

  return {
    hook,
    getInput: () => input,
    getFocusCount: () => focusCount,
  };
};

afterEach(() => {
  cleanup();
  nextTextInsertionStatus = "unavailable";
  insertedTexts.length = 0;
});

describe("useVoiceInput", () => {
  test("keeps blocked external-paste dictation in the composer", async () => {
    nextTextInsertionStatus = "blocked";
    const { hook, getInput, getFocusCount } = renderVoiceInput();

    await act(async () => {
      await hook.result.current.handleVoiceTranscript("dictated text");
    });

    expect(insertedTexts).toEqual(["dictated text"]);
    expect(getInput()).toBe("dictated text");
    expect(getFocusCount()).toBe(1);
    expect(hook.result.current.voiceError).toBe("dictation-paste-blocked");
  });

  test("keeps Automation-denied dictation in the composer", async () => {
    nextTextInsertionStatus = "automation-denied";
    const { hook, getInput, getFocusCount } = renderVoiceInput();

    await act(async () => {
      await hook.result.current.handleVoiceTranscript("open settings please");
    });

    expect(insertedTexts).toEqual(["open settings please"]);
    expect(getInput()).toBe("open settings please");
    expect(getFocusCount()).toBe(1);
    expect(hook.result.current.voiceError).toBe("dictation-automation-denied");
  });
});

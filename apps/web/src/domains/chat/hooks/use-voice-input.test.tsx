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
let nextDictationResult: { mode: "dictation"; text: string } | null = null;

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

// OS-level (TCC) mic bridge. Defaults mirror the web/Capacitor case (no
// bridge → null) so the pre-existing tests exercise the web fallback path.
type MicAccessStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";
let nextMicAccessStatus: MicAccessStatus | null = null;
let nextMicAccessGrant: boolean | null = null;
const openMicSettingsSpy = mock(async () => undefined);

mock.module("@/runtime/mic-permission", () => ({
  getMicAccessStatus: async () => nextMicAccessStatus,
  requestMicAccess: async () => nextMicAccessGrant,
  openMicSettings: openMicSettingsSpy,
}));

mock.module("@/domains/chat/components/mic-permission-primer", () => ({
  shouldShowMicPrimer: () => false,
}));

mock.module("@/domains/chat/voice/dictation-api", () => ({
  postDictation: async () => nextDictationResult,
}));

mock.module("@/domains/chat/voice/push-to-talk-host", () => ({
  shouldEnablePushToTalk: () => false,
}));

mock.module("@/domains/chat/voice/use-push-to-talk", () => ({
  usePushToTalk: () => undefined,
}));

const { useVoiceInput } = await import("./use-voice-input");

const renderVoiceInput = (assistantId: string | null = null) => {
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
    useVoiceInput({ assistantId, inputRef, setInput }),
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
  nextDictationResult = null;
  insertedTexts.length = 0;
  nextMicAccessStatus = null;
  nextMicAccessGrant = null;
  openMicSettingsSpy.mockClear();
});

describe("useVoiceInput", () => {
  test("inserts the cleaned final transcript into the front app", async () => {
    nextTextInsertionStatus = "inserted";
    nextDictationResult = { mode: "dictation", text: "cleaned text" };
    const { hook, getInput, getFocusCount } = renderVoiceInput("assistant-1");

    await act(async () => {
      await hook.result.current.handleVoiceTranscript("raw text");
    });

    expect(insertedTexts).toEqual(["cleaned text"]);
    expect(getInput()).toBe("");
    expect(getFocusCount()).toBe(0);
    expect(hook.result.current.voiceError).toBeNull();
  });

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

describe("useVoiceInput — handleRetryMicPermission (OS/TCC branch)", () => {
  test("OS denial maps to the System Settings error", async () => {
    nextMicAccessStatus = "denied";
    const { hook } = renderVoiceInput();

    await act(async () => {
      await hook.result.current.handleRetryMicPermission();
    });

    expect(hook.result.current.voiceError).toBe("not-allowed-system");
  });

  test("undetermined OS state fires the one-shot prompt and clears on grant", async () => {
    nextMicAccessStatus = "not-determined";
    nextMicAccessGrant = true;
    const { hook } = renderVoiceInput();

    await act(async () => {
      hook.result.current.setVoiceError("not-allowed");
    });
    await act(async () => {
      await hook.result.current.handleRetryMicPermission();
    });

    expect(hook.result.current.voiceError).toBeNull();
  });

  test("undetermined OS state maps a refused prompt to the System Settings error", async () => {
    nextMicAccessStatus = "not-determined";
    nextMicAccessGrant = false;
    const { hook } = renderVoiceInput();

    await act(async () => {
      await hook.result.current.handleRetryMicPermission();
    });

    expect(hook.result.current.voiceError).toBe("not-allowed-system");
  });

  test("OS grant clears the error without touching getUserMedia", async () => {
    nextMicAccessStatus = "granted";
    const { hook } = renderVoiceInput();

    await act(async () => {
      hook.result.current.setVoiceError("not-allowed");
    });
    await act(async () => {
      await hook.result.current.handleRetryMicPermission();
    });

    expect(hook.result.current.voiceError).toBeNull();
  });

  test("a failed prompt bridge call keeps the retryable error, not the System Settings one", async () => {
    nextMicAccessStatus = "not-determined";
    nextMicAccessGrant = null;
    const { hook } = renderVoiceInput();

    await act(async () => {
      await hook.result.current.handleRetryMicPermission();
    });

    expect(hook.result.current.voiceError).toBe("not-allowed");
  });

  test("handleOpenMicSettings deep-links System Settings", async () => {
    const { hook } = renderVoiceInput();

    await act(async () => {
      await hook.result.current.handleOpenMicSettings();
    });

    expect(openMicSettingsSpy).toHaveBeenCalledTimes(1);
  });
});

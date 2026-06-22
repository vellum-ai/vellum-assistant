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

let systemPermissionsSupported = false;
let nextSystemPermissionStatus: "granted" | "denied" | "not-determined" =
  "denied";
const openedSettingsKinds: string[] = [];

mock.module("@/runtime/system-permissions", () => ({
  supportsSystemPermissions: () => systemPermissionsSupported,
  requestSystemPermission: async (kind: string) => ({
    kind,
    status: nextSystemPermissionStatus,
  }),
  openSystemPermissionSettings: async (kind: string) => {
    openedSettingsKinds.push(kind);
    return null;
  },
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
  systemPermissionsSupported = false;
  nextSystemPermissionStatus = "denied";
  openedSettingsKinds.length = 0;
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

  test("omits handleOpenMicSettings when no OS settings deep-link exists", () => {
    const { hook } = renderVoiceInput();

    expect(hook.result.current.handleOpenMicSettings).toBeUndefined();
  });

  test("opens the OS microphone settings pane when supported", async () => {
    systemPermissionsSupported = true;
    const { hook } = renderVoiceInput();

    await act(async () => {
      await hook.result.current.handleOpenMicSettings?.();
    });

    expect(openedSettingsKinds).toEqual(["microphone"]);
  });

  test("maps a recorded OS denial to not-allowed-permanent on retry", async () => {
    systemPermissionsSupported = true;
    nextSystemPermissionStatus = "denied";
    const { hook } = renderVoiceInput();

    await act(async () => {
      await hook.result.current.handleRetryMicPermission();
    });

    expect(hook.result.current.voiceError).toBe("not-allowed-permanent");
  });

});

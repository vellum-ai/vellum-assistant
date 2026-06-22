import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { forwardRef, useImperativeHandle } from "react";

type TextInsertionStatus =
  | "inserted"
  | "vellum-focused"
  | "automation-denied"
  | "blocked"
  | "unavailable";

type VoiceInputButtonProps = {
  assistantId: string | null;
  onTranscript: (rawText: string) => Promise<void> | void;
  onError: (code: string | null) => void;
  onStreamReady: (stream: MediaStream | null) => void;
  onBeforeStart: () => boolean;
  renderButton: boolean;
};

let latestVoiceInputProps: VoiceInputButtonProps | null = null;
let nextTextInsertionStatus: TextInsertionStatus = "unavailable";
const insertedTexts: string[] = [];
let nextDictationResult: { mode: "dictation"; text: string } | null = null;
let overlayStopCallback: (() => void) | null = null;
const voiceStopMock = mock(() => undefined);
type ToastErrorOptions = { id?: string };
const toastErrorMock = mock(
  (_message: string, _options?: ToastErrorOptions) => undefined,
);

mock.module("@/domains/chat/components/voice-input-button", () => ({
  VoiceInputButton: forwardRef<unknown, VoiceInputButtonProps>((props, ref) => {
    latestVoiceInputProps = props;
    useImperativeHandle(ref, () => ({
      start: () => undefined,
      stop: voiceStopMock,
    }));
    return null;
  }),
}));

mock.module("@/domains/chat/hooks/use-dictation-overlay-sync", () => ({
  useDictationOverlaySync: () => undefined,
}));

mock.module("@/runtime/dictation-overlay", () => ({
  subscribeToDictationOverlayStop: (callback: () => void) => {
    overlayStopCallback = callback;
    return () => {
      if (overlayStopCallback === callback) {
        overlayStopCallback = null;
      }
    };
  },
}));

mock.module(
  "@/domains/chat/voice/use-native-push-to-talk-registration",
  () => ({
    useNativePushToTalkRegistration: () => undefined,
  }),
);

mock.module("@/domains/chat/voice/use-audio-amplitude", () => ({
  useAudioAmplitude: () => ({ amplitude: 0 }),
}));

mock.module("@/domains/chat/voice/use-push-to-talk", () => ({
  usePushToTalk: () => undefined,
}));

mock.module("@/domains/chat/voice/push-to-talk-host", () => ({
  shouldEnablePushToTalk: () => false,
}));

mock.module("@/domains/chat/voice/dictation-api", () => ({
  postDictation: async () => nextDictationResult,
}));

mock.module("@/runtime/text-insertion", () => ({
  insertTextIntoFrontApp: async (text: string) => {
    insertedTexts.push(text);
    return { status: nextTextInsertionStatus };
  },
  openTextInsertionSettings: async () => undefined,
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { error: toastErrorMock },
}));

const { GlobalPushToTalkBridge } = await import("./global-push-to-talk-bridge");
const { formatVoiceError } = await import("@/domains/chat/utils/chat");
const { useComposerStore } = await import("@/domains/chat/composer-store");
const { useVoiceRecordingStore } = await import(
  "@/domains/chat/voice/voice-recording-store"
);
const { useConversationStore } = await import("@/stores/conversation-store");
const { useViewerStore } = await import("@/stores/viewer-store");

const renderBridge = (assistantId: string | null = "assistant-1") => {
  render(<GlobalPushToTalkBridge assistantId={assistantId} />);
  if (!latestVoiceInputProps) {
    throw new Error("Expected GlobalPushToTalkBridge to mount VoiceInputButton");
  }
  return latestVoiceInputProps;
};

afterEach(() => {
  cleanup();
  latestVoiceInputProps = null;
  overlayStopCallback = null;
  voiceStopMock.mockClear();
  nextTextInsertionStatus = "unavailable";
  nextDictationResult = null;
  insertedTexts.length = 0;
  toastErrorMock.mockClear();
  useVoiceRecordingStore.getState().reset();
  useComposerStore.getState().setInput("");
  useComposerStore.getState().fullReset();
  useConversationStore.getState().reset();
  useViewerStore.getState().reset();
  localStorage.clear();
});

describe("GlobalPushToTalkBridge", () => {
  test("inserts the cleaned final transcript into the front app", async () => {
    nextTextInsertionStatus = "inserted";
    nextDictationResult = { mode: "dictation", text: "cleaned global text" };
    const voiceInput = renderBridge();

    await act(async () => {
      await voiceInput.onTranscript("raw global text");
    });

    expect(insertedTexts).toEqual(["cleaned global text"]);
    expect(useComposerStore.getState().input).toBe("");
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test("soft-lands the final transcript in the composer when front-app insertion fails", async () => {
    nextTextInsertionStatus = "blocked";
    const voiceInput = renderBridge();

    await act(async () => {
      await voiceInput.onTranscript("fallback text");
    });

    expect(insertedTexts).toEqual(["fallback text"]);
    expect(useComposerStore.getState().input).toBe("fallback text");
    expect(toastErrorMock).toHaveBeenCalledWith(
      formatVoiceError("dictation-paste-blocked"),
      { id: "voice-error:dictation-paste-blocked" },
    );
  });

  test("uses stable toast IDs for repeated voice errors", () => {
    const voiceInput = renderBridge();

    act(() => {
      voiceInput.onError("stt-not-configured");
      voiceInput.onError("stt-not-configured");
    });

    expect(toastErrorMock.mock.calls).toEqual([
      [
        formatVoiceError("stt-not-configured"),
        { id: "voice-error:stt-not-configured" },
      ],
      [
        formatVoiceError("stt-not-configured"),
        { id: "voice-error:stt-not-configured" },
      ],
    ]);
  });

  test("stops the active voice input when the overlay requests stop during recording", () => {
    renderBridge();

    act(() => {
      useVoiceRecordingStore.getState().startRecording();
    });
    act(() => {
      overlayStopCallback?.();
    });

    expect(voiceStopMock).toHaveBeenCalledTimes(1);
  });

  test("ignores overlay stop requests outside a recording session", () => {
    renderBridge();

    act(() => {
      overlayStopCallback?.();
    });

    expect(voiceStopMock).not.toHaveBeenCalled();
  });
});

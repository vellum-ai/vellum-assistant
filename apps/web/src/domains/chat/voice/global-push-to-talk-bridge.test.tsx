import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { forwardRef } from "react";

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
const showTranscriptionOverlayMock = mock(
  async (_state: { transcript: string }) => undefined,
);
const toastErrorMock = mock((_message: string) => undefined);

mock.module("@/domains/chat/components/voice-input-button", () => ({
  VoiceInputButton: forwardRef<unknown, VoiceInputButtonProps>((props, _ref) => {
    latestVoiceInputProps = props;
    return null;
  }),
}));

mock.module("@/domains/chat/hooks/use-dictation-overlay-sync", () => ({
  useDictationOverlaySync: () => undefined,
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

mock.module("@/runtime/transcription-overlay", () => ({
  showTranscriptionOverlay: showTranscriptionOverlayMock,
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { error: toastErrorMock },
}));

const { GlobalPushToTalkBridge } = await import("./global-push-to-talk-bridge");
const { useComposerStore } = await import("@/domains/chat/composer-store");
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
  nextTextInsertionStatus = "unavailable";
  nextDictationResult = null;
  insertedTexts.length = 0;
  showTranscriptionOverlayMock.mockClear();
  toastErrorMock.mockClear();
  useComposerStore.getState().setInput("");
  useComposerStore.getState().fullReset();
  useConversationStore.getState().reset();
  useViewerStore.getState().reset();
  localStorage.clear();
});

describe("GlobalPushToTalkBridge", () => {
  test("shows the cleaned final transcript after successful front-app insertion", async () => {
    nextTextInsertionStatus = "inserted";
    nextDictationResult = { mode: "dictation", text: "cleaned global text" };
    const voiceInput = renderBridge();

    await act(async () => {
      await voiceInput.onTranscript("raw global text");
    });

    expect(insertedTexts).toEqual(["cleaned global text"]);
    expect(showTranscriptionOverlayMock).toHaveBeenCalledWith({
      transcript: "cleaned global text",
    });
    expect(useComposerStore.getState().input).toBe("");
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test("shows the final transcript when front-app insertion fails and soft-lands in composer", async () => {
    nextTextInsertionStatus = "blocked";
    const voiceInput = renderBridge();

    await act(async () => {
      await voiceInput.onTranscript("fallback text");
    });

    expect(insertedTexts).toEqual(["fallback text"]);
    expect(showTranscriptionOverlayMock).toHaveBeenCalledWith({
      transcript: "fallback text",
    });
    expect(useComposerStore.getState().input).toBe("fallback text");
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  test("does not show the final overlay for empty transcripts", async () => {
    const voiceInput = renderBridge();

    await act(async () => {
      await voiceInput.onTranscript("   ");
    });

    expect(showTranscriptionOverlayMock).not.toHaveBeenCalled();
  });
});

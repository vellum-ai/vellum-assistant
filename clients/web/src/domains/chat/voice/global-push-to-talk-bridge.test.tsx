import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { forwardRef, useImperativeHandle } from "react";
import { MemoryRouter } from "react-router";

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
const voiceStartMock = mock(() => true);
type ToastErrorOptions = { id?: string };
const toastErrorMock = mock(
  (_message: string, _options?: ToastErrorOptions) => undefined,
);

mock.module("@/domains/chat/components/voice-input-button", () => ({
  VoiceInputButton: forwardRef<unknown, VoiceInputButtonProps>((props, ref) => {
    latestVoiceInputProps = props;
    useImperativeHandle(ref, () => ({
      start: voiceStartMock,
      stop: voiceStopMock,
    }));
    return null;
  }),
}));

type HoldStart = {
  selection: { text: string; truncated: boolean } | null;
};
let holdHandlers: {
  onHoldStart: (start: HoldStart) => void;
  onHoldEnd: () => void;
} | null = null;
mock.module("@/domains/chat/voice/use-hold-to-dictate", () => ({
  HOLD_ARMING_MS: 220,
  useHoldToDictate: (options: {
    onHoldStart: (start: HoldStart) => void;
    onHoldEnd: () => void;
  }) => {
    holdHandlers = options;
  },
}));

const askedTexts: string[] = [];
let nextAskTaken = true;
const announceAskRefusedMock = mock(() => undefined);
mock.module("@/domains/chat/voice/live-voice/start-voice-request", () => ({
  askVoiceFromSurface: (_navigate: unknown, ask: string) => {
    askedTexts.push(ask);
    return nextAskTaken;
  },
  announceAskRefused: announceAskRefusedMock,
  startVoiceFromSurface: () => undefined,
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

mock.module("@/domains/chat/voice/keyboard-activation-host", () => ({
  supportsKeyboardActivation: () => false,
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

// The design-library barrel re-exports every name from this module, so the
// mock must cover the full export surface or barrel linking fails.
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { error: toastErrorMock },
  Toaster: () => null,
  ToastContent: () => null,
}));

const { GlobalPushToTalkBridge } = await import("./global-push-to-talk-bridge");
const { formatVoiceError } = await import("@/domains/chat/utils/chat");
const { useComposerStore } = await import("@/domains/chat/composer-store");
const { useVoiceRecordingStore } =
  await import("@/domains/chat/voice/voice-recording-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useViewerStore } = await import("@/stores/viewer-store");

const renderBridge = (assistantId: string | null = "assistant-1") => {
  // The bridge's voice mode shortcut navigates to the conversation surface
  // when a press finds no composer, so it renders under a router in the app.
  render(
    <MemoryRouter>
      <GlobalPushToTalkBridge assistantId={assistantId} />
    </MemoryRouter>,
  );
  if (!latestVoiceInputProps) {
    throw new Error(
      "Expected GlobalPushToTalkBridge to mount VoiceInputButton",
    );
  }
  return latestVoiceInputProps;
};

afterEach(() => {
  cleanup();
  latestVoiceInputProps = null;
  overlayStopCallback = null;
  voiceStopMock.mockClear();
  voiceStartMock.mockClear();
  voiceStartMock.mockReturnValue(true);
  nextTextInsertionStatus = "unavailable";
  nextDictationResult = null;
  insertedTexts.length = 0;
  askedTexts.length = 0;
  nextAskTaken = true;
  announceAskRefusedMock.mockClear();
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

  test("lands a soft-landed transcript in the conversation already selected", async () => {
    // Dictation is text the user is composing, so it belongs in the chat they
    // are already in. Reading the selection first is also what keeps a press
    // made from another app from throwing the main view over to the chat.
    useConversationStore.getState().setActiveConversationId("conv-existing");
    useViewerStore.getState().setMainView("app");
    const voiceInput = renderBridge();

    await act(async () => {
      await voiceInput.onTranscript("dictated text");
    });

    expect(useConversationStore.getState().activeConversationId).toBe(
      "conv-existing",
    );
    expect(useConversationStore.getState().draftConversationIds.size).toBe(0);
    expect(useViewerStore.getState().mainView).toBe("app");
    expect(useComposerStore.getState().input).toBe("dictated text");
  });

  test("mints a draft and reveals the chat when nothing is selected", async () => {
    // The fallback, and the only case that mints: a press made on a route with
    // no conversation selected still needs a composer to land the text in.
    useConversationStore.getState().setActiveConversationId(null);
    useViewerStore.getState().setMainView("app");
    const voiceInput = renderBridge();

    await act(async () => {
      await voiceInput.onTranscript("dictated text");
    });

    const draftId = useConversationStore.getState().activeConversationId;
    expect(draftId).not.toBeNull();
    expect(
      useConversationStore.getState().draftConversationIds.has(draftId ?? ""),
    ).toBe(true);
    expect(useViewerStore.getState().mainView).toBe("chat");
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

/**
 * A hold is aimed at a cursor in another application, and its words belong
 * there. The composer's microphone registers itself as the global dictation
 * target whenever a chat route is mounted, and routing a hold through that one
 * splices the transcript into the composer and sends it as a turn: the words
 * never reach the cursor, and a turn is spent that nobody asked for.
 */
test("drives its own recorder, not whatever claimed dictation last", async () => {
  const { registerPushToTalkTarget } =
    await import("@/domains/chat/voice/push-to-talk-target");
  const composerStart = mock(() => undefined);
  const composerStop = mock(() => undefined);
  const release = registerPushToTalkTarget({
    start: composerStart,
    stop: composerStop,
  });

  renderBridge("a1");

  act(() => {
    holdHandlers?.onHoldStart({ selection: null });
  });
  useVoiceRecordingStore.setState({ phase: "recording" });
  act(() => {
    holdHandlers?.onHoldEnd();
  });

  expect(composerStart).not.toHaveBeenCalled();
  expect(composerStop).not.toHaveBeenCalled();
  expect(voiceStopMock).toHaveBeenCalled();

  release();
});

/**
 * A hold made over a selection is a question about it. The words go to the
 * assistant with the selection quoted ahead of them, and nothing is pasted or
 * cleaned up: the cleanup pass rewrites words meant for a document.
 */
describe("a hold over a selection", () => {
  test("asks the assistant instead of pasting", async () => {
    nextTextInsertionStatus = "inserted";
    nextDictationResult = { mode: "dictation", text: "cleaned" };
    const voiceInput = renderBridge("a1");

    act(() => {
      holdHandlers?.onHoldStart({
        selection: { text: "the powerhouse\nof the cell", truncated: false },
      });
    });
    await act(async () => {
      await voiceInput.onTranscript("what does this mean");
    });

    expect(askedTexts).toEqual([
      "> the powerhouse\n> of the cell\n\nwhat does this mean",
    ]);
    expect(insertedTexts).toEqual([]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test("says when a selection was cut short", async () => {
    const voiceInput = renderBridge("a1");

    act(() => {
      holdHandlers?.onHoldStart({
        selection: { text: "a long passage", truncated: true },
      });
    });
    await act(async () => {
      await voiceInput.onTranscript("summarize this");
    });

    expect(askedTexts).toEqual([
      "> a long passage\n> [selection continues]\n\nsummarize this",
    ]);
  });

  test("is spent by its own transcript, so the next hold dictates", async () => {
    nextTextInsertionStatus = "inserted";
    const voiceInput = renderBridge("a1");

    act(() => {
      holdHandlers?.onHoldStart({
        selection: { text: "selected", truncated: false },
      });
    });
    await act(async () => {
      await voiceInput.onTranscript("first");
    });
    act(() => {
      holdHandlers?.onHoldStart({ selection: null });
    });
    await act(async () => {
      await voiceInput.onTranscript("second");
    });

    expect(askedTexts).toHaveLength(1);
    expect(insertedTexts).toEqual(["second"]);
  });

  test("a hold the recorder refuses does not rebind the selection", async () => {
    nextTextInsertionStatus = "inserted";
    const voiceInput = renderBridge("a1");

    act(() => {
      holdHandlers?.onHoldStart({
        selection: { text: "first", truncated: false },
      });
    });
    // The first transcript is still being finished when the next hold lands,
    // so the recorder turns it away.
    voiceStartMock.mockReturnValue(false);
    act(() => {
      holdHandlers?.onHoldStart({
        selection: { text: "second", truncated: false },
      });
    });
    await act(async () => {
      await voiceInput.onTranscript("what is this");
    });

    expect(askedTexts).toEqual(["> first\n\nwhat is this"]);
  });

  test("tells the user when the call cannot take the question", async () => {
    nextAskTaken = false;
    const voiceInput = renderBridge("a1");

    act(() => {
      holdHandlers?.onHoldStart({
        selection: { text: "selected", truncated: false },
      });
    });
    await act(async () => {
      await voiceInput.onTranscript("what is this");
    });

    expect(insertedTexts).toEqual([]);
    expect(announceAskRefusedMock).toHaveBeenCalledTimes(1);
  });
});

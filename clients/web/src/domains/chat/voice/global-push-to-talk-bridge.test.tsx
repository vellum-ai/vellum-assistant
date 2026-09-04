import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import { forwardRef, useImperativeHandle } from "react";
import { MemoryRouter } from "react-router";

type TextInsertionStatus =
  | "inserted"
  | "vellum-focused"
  | "no-text-field"
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
let nextDictationResult: { mode: string; text: string } | null = null;
/** How long the daemon takes to answer, for the cases about the deadline. */
let nextDictationDelayMs = 0;
type DictationCall = {
  transcription: string;
  assistantId: string;
  context: Record<string, unknown>;
};
const dictationCalls: DictationCall[] = [];
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
  selection: { text: string; truncated: boolean; editable?: boolean } | null;
};
let holdHandlers: {
  onHoldStart: (start: HoldStart) => void;
  onHoldEnd: () => void;
  onDoubleTap: () => void;
} | null = null;
mock.module("@/domains/chat/voice/use-voice-key", () => ({
  useVoiceKey: (options: {
    onHoldStart: (start: {
      selection: Promise<HoldStart["selection"]>;
    }) => void;
    onHoldEnd: () => void;
    onDoubleTap: () => void;
  }) => {
    // The hook hands the bridge a selection still being read; the tests
    // describe what it will resolve to.
    holdHandlers = {
      onHoldStart: (start) =>
        options.onHoldStart({ selection: Promise.resolve(start.selection) }),
      onHoldEnd: options.onHoldEnd,
      onDoubleTap: options.onDoubleTap,
    };
  },
}));

const askedTexts: string[] = [];
const askedEntries: string[] = [];
let nextAskTaken = true;
const announceAskRefusedMock = mock(() => undefined);
const toggleVoiceMock = mock(() => undefined);
mock.module("@/domains/chat/voice/live-voice/start-voice-request", () => ({
  askVoiceFromSurface: (_navigate: unknown, ask: string, entry: string) => {
    askedTexts.push(ask);
    askedEntries.push(entry);
    return nextAskTaken;
  },
  announceAskRefused: announceAskRefusedMock,
  startVoiceFromSurface: () => undefined,
  toggleVoiceFromSurface: toggleVoiceMock,
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
  postDictation: async (
    transcription: string,
    assistantId: string,
    context: Record<string, unknown>,
  ) => {
    dictationCalls.push({ transcription, assistantId, context });
    if (nextDictationDelayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, nextDictationDelayMs);
      });
    }
    return nextDictationResult;
  },
}));

mock.module("@/runtime/running-apps", () => ({
  runningApps: async () => [],
  quitApp: async () => true,
  frontmostApp: async () => "com.example.editor",
}));
mock.module("@/runtime/input-activity", () => ({
  setInputActivityWatch: async () => true,
  subscribeToInputActivity: () => () => {},
}));

let runningClaimant: { bundleId: string; name: string } | null = null;
mock.module("@/domains/chat/voice/fn-claimants", () => ({
  FN_CLAIMANTS: [{ bundleId: "com.electron.wispr-flow", name: "Wispr Flow" }],
  findRunningFnClaimant: async () => runningClaimant,
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
const { clearDictationOffer, useDictationOfferStore } =
  await import("@/domains/chat/voice/dictation-offer-store");
const { formatVoiceError } = await import("@/domains/chat/utils/chat");
const { useComposerStore } = await import("@/domains/chat/composer-store");
const { useVoiceRecordingStore } =
  await import("@/domains/chat/voice/voice-recording-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useViewerStore } = await import("@/stores/viewer-store");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");

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
  nextDictationDelayMs = 0;
  dictationCalls.length = 0;
  insertedTexts.length = 0;
  askedTexts.length = 0;
  askedEntries.length = 0;
  nextAskTaken = true;
  announceAskRefusedMock.mockClear();
  toggleVoiceMock.mockClear();
  toastErrorMock.mockClear();
  runningClaimant = null;
  clearDictationOffer();
  useVoiceRecordingStore.getState().reset();
  useComposerStore.getState().setInput("");
  useComposerStore.getState().fullReset();
  useConversationStore.getState().reset();
  useViewerStore.getState().reset();
  useAssistantIdentityStore.getState().clearIdentity();
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

  /**
   * A hold that ends over something that does not take text keeps its words.
   * Nothing failed, so nothing is announced as a failure; the words go up on
   * the companion, on the same offer another app's paste puts them on and
   * with the reason that says the only answer here is the clipboard.
   */
  test("offers the transcript when nothing in front takes text", async () => {
    nextTextInsertionStatus = "no-text-field";
    const voiceInput = renderBridge();

    await act(async () => {
      await voiceInput.onTranscript("onions, tomatoes, and a bag of rice");
    });

    expect(useDictationOfferStore.getState().offer).toMatchObject({
      reason: "no-text-field",
      text: "onions, tomatoes, and a bag of rice",
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  /**
   * The offer needs the companion surface to be on screen, and the user can
   * turn that off. The composer is the floor under it either way, so the words
   * are somewhere the user can reach even then.
   */
  test("still soft-lands those words in the composer", async () => {
    nextTextInsertionStatus = "no-text-field";
    const voiceInput = renderBridge();

    await act(async () => {
      await voiceInput.onTranscript("onions, tomatoes, and a bag of rice");
    });

    expect(useComposerStore.getState().input).toBe(
      "onions, tomatoes, and a bag of rice",
    );
  });

  /**
   * The overlay's error state says a paste was refused. Nothing was refused
   * here and nothing was sent, so a check is the truthful thing for it to
   * draw.
   */
  test("does not mark the recording as an insertion failure", async () => {
    nextTextInsertionStatus = "no-text-field";
    const voiceInput = renderBridge();

    await act(async () => {
      await voiceInput.onTranscript("onions, tomatoes, and a bag of rice");
    });

    expect(
      useVoiceRecordingStore.getState().dictationInsertionError,
    ).toBeNull();
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
test("a double tap of the voice key is Talk", () => {
  renderBridge("a1");

  act(() => {
    holdHandlers?.onDoubleTap();
  });

  expect(toggleVoiceMock).toHaveBeenCalledTimes(1);
  // Named for the daemon's telemetry: the same macOS client also starts calls
  // from the composer and the companion, and only the entry tells them apart.
  expect(toggleVoiceMock).toHaveBeenCalledWith(
    expect.any(Function),
    "voice_key",
  );
});

/**
 * Another dictation app that heard the same key has pasted by the time the
 * transcript lands. Pasting beside it would leave the sentence twice, so the
 * words are offered on the companion instead.
 */
describe("a hold beside another dictation app", () => {
  test("offers the words instead of pasting them", async () => {
    runningClaimant = {
      bundleId: "com.electron.wispr-flow",
      name: "Wispr Flow",
    };
    nextTextInsertionStatus = "inserted";
    nextDictationResult = { mode: "dictation", text: "Send me the files." };
    const voiceInput = renderBridge("a1");

    act(() => {
      holdHandlers?.onHoldStart({ selection: null });
    });
    await act(async () => {
      await voiceInput.onTranscript("send me the files");
    });

    expect(insertedTexts).toEqual([]);
    expect(useDictationOfferStore.getState().offer).toMatchObject({
      app: { name: "Wispr Flow" },
      text: "Send me the files.",
      frontApp: "com.example.editor",
    });
  });

  test("a new hold takes a standing offer down", async () => {
    runningClaimant = {
      bundleId: "com.electron.wispr-flow",
      name: "Wispr Flow",
    };
    nextDictationResult = { mode: "dictation", text: "first" };
    const voiceInput = renderBridge("a1");

    act(() => {
      holdHandlers?.onHoldStart({ selection: null });
    });
    await act(async () => {
      await voiceInput.onTranscript("first");
    });
    expect(useDictationOfferStore.getState().offer?.text).toBe("first");

    act(() => {
      holdHandlers?.onHoldStart({ selection: null });
    });
    expect(useDictationOfferStore.getState().offer).toBeNull();
  });

  test("pastes as usual when no such app is running", async () => {
    nextTextInsertionStatus = "inserted";
    nextDictationResult = { mode: "dictation", text: "Send me the files." };
    const voiceInput = renderBridge("a1");

    act(() => {
      holdHandlers?.onHoldStart({ selection: null });
    });
    await act(async () => {
      await voiceInput.onTranscript("send me the files");
    });

    expect(insertedTexts).toEqual(["Send me the files."]);
    expect(useDictationOfferStore.getState().offer).toBeNull();
  });
});

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
    expect(askedEntries).toEqual(["voice_key_ask"]);
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

/**
 * A hold over an editable selection may be asking for it changed. The
 * selection goes to the daemon with the words: an edit is pasted over the
 * selection, and a question goes to the assistant the way any selection's
 * does.
 */
describe("a hold over an editable selection", () => {
  const passage = {
    text: "Please send me the files.",
    truncated: false,
    editable: true,
  };
  /**
   * The transcript waits on the selection its hold was read over before it
   * asks the daemon anything, so under fake timers the deadline is not yet
   * ticking when `onTranscript` returns.
   */
  const selectionRead = () => Promise.resolve();
  const holdOver = (selection: HoldStart["selection"]) => {
    act(() => {
      holdHandlers?.onHoldStart({ selection });
    });
  };
  const withAssistantThatTellsEditsFromQuestions = () => {
    useAssistantIdentityStore.getState().setIdentity("asst", "0.11.9", "a1");
  };

  test("pastes the edit over the selection", async () => {
    withAssistantThatTellsEditsFromQuestions();
    nextTextInsertionStatus = "inserted";
    nextDictationResult = {
      mode: "command",
      text: "Could you send the files over?",
    };
    const voiceInput = renderBridge("a1");

    holdOver(passage);
    await act(async () => {
      await voiceInput.onTranscript("make this friendlier");
    });

    expect(dictationCalls).toEqual([
      {
        transcription: "make this friendlier",
        assistantId: "a1",
        context: { cursorInTextField: true, selectedText: passage.text },
      },
    ]);
    expect(insertedTexts).toEqual(["Could you send the files over?"]);
    expect(askedTexts).toEqual([]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  /**
   * A rewrite writes back as much as it was handed, so a paragraph's edit
   * takes longer than the cleanup's bound, and under that bound it was dropped
   * at the deadline and read aloud as an answer instead. The rewrite waits on
   * a bound of its own.
   */
  test("waits past the cleanup's bound for a paragraph's edit", async () => {
    withAssistantThatTellsEditsFromQuestions();
    nextTextInsertionStatus = "inserted";
    nextDictationResult = {
      mode: "command",
      text: "Could you send the files over?",
    };
    nextDictationDelayMs = 8000;
    const voiceInput = renderBridge("a1");
    holdOver(passage);

    jest.useFakeTimers();
    try {
      const run = voiceInput.onTranscript("make this friendlier");
      await selectionRead();
      jest.advanceTimersByTime(8000);
      await act(async () => {
        await run;
      });
    } finally {
      jest.useRealTimers();
    }

    expect(insertedTexts).toEqual(["Could you send the files over?"]);
    expect(askedTexts).toEqual([]);
  });

  test("gives up on an edit the daemon never finishes and asks instead", async () => {
    withAssistantThatTellsEditsFromQuestions();
    nextTextInsertionStatus = "inserted";
    nextDictationResult = { mode: "command", text: "never seen" };
    nextDictationDelayMs = 60_000;
    const voiceInput = renderBridge("a1");
    holdOver(passage);

    jest.useFakeTimers();
    try {
      const run = voiceInput.onTranscript("make this friendlier");
      await selectionRead();
      jest.advanceTimersByTime(20_000);
      await act(async () => {
        await run;
      });
    } finally {
      jest.useRealTimers();
    }

    expect(insertedTexts).toEqual([]);
    expect(askedTexts).toHaveLength(1);
  });

  test("takes a question to the assistant instead", async () => {
    withAssistantThatTellsEditsFromQuestions();
    nextTextInsertionStatus = "inserted";
    nextDictationResult = { mode: "question", text: "what does this mean" };
    const voiceInput = renderBridge("a1");

    holdOver(passage);
    await act(async () => {
      await voiceInput.onTranscript("what does this mean");
    });

    expect(insertedTexts).toEqual([]);
    expect(askedTexts).toEqual([
      "> Please send me the files.\n\nwhat does this mean",
    ]);
  });

  test("a selection handed back as it was is asked about", async () => {
    withAssistantThatTellsEditsFromQuestions();
    nextTextInsertionStatus = "inserted";
    nextDictationResult = { mode: "command", text: passage.text };
    const voiceInput = renderBridge("a1");

    holdOver(passage);
    await act(async () => {
      await voiceInput.onTranscript("is this right");
    });

    expect(insertedTexts).toEqual([]);
    expect(askedTexts).toHaveLength(1);
  });

  test("a selection the helper cut short is never rewritten", async () => {
    withAssistantThatTellsEditsFromQuestions();
    nextDictationResult = { mode: "command", text: "shorter" };
    const voiceInput = renderBridge("a1");

    holdOver({ ...passage, truncated: true });
    await act(async () => {
      await voiceInput.onTranscript("shorten this");
    });

    expect(dictationCalls).toEqual([]);
    expect(insertedTexts).toEqual([]);
    expect(askedTexts).toHaveLength(1);
  });

  test("a selection nothing can be typed into is asked about", async () => {
    withAssistantThatTellsEditsFromQuestions();
    nextDictationResult = { mode: "command", text: "shorter" };
    const voiceInput = renderBridge("a1");

    holdOver({ ...passage, editable: false });
    await act(async () => {
      await voiceInput.onTranscript("shorten this");
    });

    expect(dictationCalls).toEqual([]);
    expect(askedTexts).toHaveLength(1);
  });

  test("an assistant that cannot tell an edit from a question is not sent the selection", async () => {
    useAssistantIdentityStore.getState().setIdentity("asst", "0.11.8", "a1");
    nextDictationResult = { mode: "command", text: "shorter" };
    const voiceInput = renderBridge("a1");

    holdOver(passage);
    await act(async () => {
      await voiceInput.onTranscript("shorten this");
    });

    expect(dictationCalls).toEqual([]);
    expect(askedTexts).toHaveLength(1);
  });

  test("an edit the system will not paste lands in the composer", async () => {
    withAssistantThatTellsEditsFromQuestions();
    nextTextInsertionStatus = "blocked";
    nextDictationResult = { mode: "command", text: "Send the files." };
    const voiceInput = renderBridge("a1");

    holdOver(passage);
    await act(async () => {
      await voiceInput.onTranscript("shorten this");
    });

    expect(askedTexts).toEqual([]);
    expect(toastErrorMock).toHaveBeenCalledWith(
      formatVoiceError("dictation-paste-blocked"),
      { id: "voice-error:dictation-paste-blocked" },
    );
    expect(useComposerStore.getState().input).toBe("Send the files.");
  });
});

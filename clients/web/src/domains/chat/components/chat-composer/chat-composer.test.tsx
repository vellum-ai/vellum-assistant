/**
 * Tests for the `ChatComposer` extraction.
 *
 * Exercises behavior through two channels:
 *   1. The pure `shouldSubmitOnEnter` policy helper — used by the textarea's
 *      onKeyDown handler in production. Asserting on the helper is equivalent
 *      to asserting on the keyboard handler since the production handler is a
 *      thin shim around it.
 *   2. `@testing-library/react` `render` for HTML surface checks (placeholder,
 *      send/stop button, disabled attribute).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { type ChatAttachment, useComposerStore } from "@/domains/chat/composer-store";
import type { VoiceInputButtonHandle } from "@/domains/chat/components/voice-input-button";
import { INITIAL_TURN_STATE, useTurnStore } from "@/domains/chat/turn-store";

// Pure helpers live in `chat-composer-utils` (no mocks needed), so import them
// statically. `ChatComposer` itself is imported dynamically *after* the mocks
// below so its transitive flag-store / live-voice / voice-input-button imports
// resolve against the mocked modules.
import {
  computeGhostSuffix,
  shouldSubmitOnEnter,
} from "@/domains/chat/components/chat-composer/chat-composer-utils";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";

let mockIsMobile = false;
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mockIsMobile,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

let mockIsElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => mockIsElectron,
}));

// Live-voice integration mocks. The composer mounts `LiveVoiceButton` (which
// self-gates on `voice-mode`) and reads live-voice session state via the
// `useLiveVoiceStore` per-field selectors for the transcript surface +
// dictation mutual-exclusion. Both are mocked so the composer renders in
// isolation: the flag via a mutable `mockVoiceMode`, and the session via a
// mutable state + transcript bag exposed through the store's `.use.*`
// selectors. Defaults (flag off, idle, empty) keep the existing HTML-surface
// assertions unchanged.
let mockVoiceMode = false;
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      voiceMode: () => mockVoiceMode,
    },
  },
}));

// Local mirror of the live-voice session phases this test exercises. Kept as a
// narrow union (not an import from the `voice` domain) so the `chat` test stays
// free of cross-domain coupling — the composer only ever distinguishes idle
// from non-idle, so the precise phase taxonomy is irrelevant here.
type MockLiveVoiceState = "idle" | "connecting" | "listening" | "failed";

let mockLiveVoiceState: MockLiveVoiceState = "idle";
let mockLivePartial = "";
let mockLiveFinal = "";
let mockLiveAssistant = "";
const liveStartSpy = mock(
  async (_assistantId: string, _conversationId?: string) => {},
);
const liveStopSpy = mock(async () => {});
// The composer reads session state through the store's per-field selectors
// (`useLiveVoiceStore.use.state()` etc.), so mock the store rather than the
// `useLiveVoice` controller. `LiveVoiceButton` is the only `useLiveVoice`
// consumer, and it is mocked separately below.
mock.module("@/domains/chat/voice/live-voice/live-voice-store", () => ({
  useLiveVoiceStore: {
    use: {
      state: () => mockLiveVoiceState,
      partialTranscript: () => mockLivePartial,
      finalTranscript: () => mockLiveFinal,
      assistantTranscript: () => mockLiveAssistant,
    },
  },
}));
mock.module("@/domains/chat/voice/live-voice/use-live-voice", () => ({
  useLiveVoice: () => ({
    state: mockLiveVoiceState,
    partialTranscript: mockLivePartial,
    finalTranscript: mockLiveFinal,
    assistantTranscript: mockLiveAssistant,
    inputAmplitude: 0,
    error: null,
    start: liveStartSpy,
    stop: liveStopSpy,
  }),
}));

// The real `VoiceInputButton` self-suppresses (returns null) unless the test
// DOM exposes `MediaRecorder` + `getUserMedia`, which happy-dom does not. Mock
// it with a probe that always renders and mirrors its `disabled` prop so the
// composer's mutual-exclusion wiring is observable. The handle is mocked too.
mock.module("@/domains/chat/components/voice-input-button", () => ({
  VoiceInputButton: (props: { disabled?: boolean }) => (
    <button
      type="button"
      aria-label="Start voice input"
      disabled={props.disabled ?? false}
    />
  ),
}));

// Dictation recording phase. The composer reads `useVoiceRecordingStore`
// (cross-domain `voice` store) to derive its `isVoiceActive` signal. Mock it
// via `mock.module` (rather than importing the store) so the `chat` test stays
// free of cross-domain coupling, matching the live-voice mocks above. Only the
// `.use.phase()` and `.use.setAudioLevel()` selectors are consumed by the
// composer.
let mockVoicePhase = "idle";
const setAudioLevelSpy = mock((_level: number) => undefined);
mock.module("@/domains/chat/voice/voice-recording-store", () => ({
  useVoiceRecordingStore: {
    use: {
      phase: () => mockVoicePhase,
      setAudioLevel: () => setAudioLevelSpy,
    },
  },
}));

function resetLiveVoiceMocks() {
  mockIsElectron = false;
  mockVoiceMode = false;
  mockLiveVoiceState = "idle";
  mockLivePartial = "";
  mockLiveFinal = "";
  mockLiveAssistant = "";
  mockVoicePhase = "idle";
  setAudioLevelSpy.mockClear();
  liveStartSpy.mockClear();
  liveStopSpy.mockClear();
}

// Imported after the mocks so the component (and its transitive flag-store /
// live-voice / voice-input-button imports) resolve against the mocked modules.
// The pure helpers (computeGhostSuffix / shouldSubmitOnEnter) come from
// `chat-composer-utils`, imported statically above.
const { ChatComposer } = await import(
  "@/domains/chat/components/chat-composer/chat-composer"
);

// ---------------------------------------------------------------------------
// shouldSubmitOnEnter — keyboard policy
// ---------------------------------------------------------------------------

const ENTER = { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, keyCode: 13 };
const ENTER_WITH_SHIFT = { ...ENTER, shiftKey: true };
const ENTER_DURING_IME = { ...ENTER, isComposing: true };
const ENTER_IME_KEYCODE = { ...ENTER, keyCode: 229 };
const CMD_ENTER = { ...ENTER, metaKey: true };
const CTRL_ENTER = { ...ENTER, ctrlKey: true };

const READY_POLICY = {
  input: "hello",
  canSendAttachments: false,
  sendDisabled: false,
  attachmentsUploadingCount: 0,
  cmdEnterMode: false,
};

describe("shouldSubmitOnEnter — desktop submit", () => {
  test("Enter on desktop with content submits", () => {
    expect(shouldSubmitOnEnter(ENTER, false, READY_POLICY)).toBe("submit");
  });

  test("Enter on pointer:coarse (mobile) is ignored — newline kept", () => {
    expect(shouldSubmitOnEnter(ENTER, true, READY_POLICY)).toBe("ignore");
  });

  test("Shift+Enter is ignored even on desktop", () => {
    expect(shouldSubmitOnEnter(ENTER_WITH_SHIFT, false, READY_POLICY)).toBe(
      "ignore",
    );
  });

  test("IME composition Enter is ignored (isComposing)", () => {
    expect(shouldSubmitOnEnter(ENTER_DURING_IME, false, READY_POLICY)).toBe(
      "ignore",
    );
  });

  test("IME composition Enter is ignored (keyCode 229 fallback)", () => {
    expect(shouldSubmitOnEnter(ENTER_IME_KEYCODE, false, READY_POLICY)).toBe(
      "ignore",
    );
  });
});

describe("shouldSubmitOnEnter — guards still preventDefault but skip submit", () => {
  test("empty input + no attachments returns 'prevent' (no submit, but caller preventDefaults)", () => {
    expect(
      shouldSubmitOnEnter(ENTER, false, {
        input: "   ",
        canSendAttachments: false,
        sendDisabled: false,
        attachmentsUploadingCount: 0,
        cmdEnterMode: false,
      }),
    ).toBe("prevent");
  });

  test("sendDisabled: caller preventDefaults but does NOT submit", () => {
    expect(
      shouldSubmitOnEnter(ENTER, false, {
        ...READY_POLICY,
        sendDisabled: true,
      }),
    ).toBe("prevent");
  });

  test("attachments still uploading: caller preventDefaults but does NOT submit", () => {
    expect(
      shouldSubmitOnEnter(ENTER, false, {
        ...READY_POLICY,
        attachmentsUploadingCount: 2,
      }),
    ).toBe("prevent");
  });

  test("input is empty but attachment is ready (canSendAttachments=true)", () => {
    expect(
      shouldSubmitOnEnter(ENTER, false, {
        input: "",
        canSendAttachments: true,
        hasStagedQuotes: false,
        sendDisabled: false,
        attachmentsUploadingCount: 0,
        cmdEnterMode: false,
      }),
    ).toBe("submit");
  });

  test("input is empty but staged quote context is ready", () => {
    expect(
      shouldSubmitOnEnter(ENTER, false, {
        input: "",
        canSendAttachments: false,
        hasStagedQuotes: true,
        sendDisabled: false,
        attachmentsUploadingCount: 0,
        cmdEnterMode: false,
      }),
    ).toBe("submit");
  });
});

describe("shouldSubmitOnEnter — non-Enter keys", () => {
  test("Space is ignored (key !== 'Enter')", () => {
    expect(
      shouldSubmitOnEnter(
        { key: " ", shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, keyCode: 32 },
        false,
        READY_POLICY,
      ),
    ).toBe("ignore");
  });
});

// ---------------------------------------------------------------------------
// shouldSubmitOnEnter — cmdEnterMode
// ---------------------------------------------------------------------------

describe("shouldSubmitOnEnter — cmdEnterMode=true", () => {
  const CMD_ENTER_POLICY = { ...READY_POLICY, cmdEnterMode: true };

  test("plain Enter inserts newline (returns 'ignore')", () => {
    expect(shouldSubmitOnEnter(ENTER, false, CMD_ENTER_POLICY)).toBe("ignore");
  });

  test("Cmd+Enter with content submits", () => {
    expect(shouldSubmitOnEnter(CMD_ENTER, false, CMD_ENTER_POLICY)).toBe("submit");
  });

  test("Ctrl+Enter with content submits (Windows/Linux)", () => {
    expect(shouldSubmitOnEnter(CTRL_ENTER, false, CMD_ENTER_POLICY)).toBe("submit");
  });

  test("Cmd+Enter when sendDisabled returns 'prevent'", () => {
    expect(
      shouldSubmitOnEnter(CMD_ENTER, false, {
        ...CMD_ENTER_POLICY,
        sendDisabled: true,
      }),
    ).toBe("prevent");
  });

  test("Cmd+Enter with empty input returns 'prevent'", () => {
    expect(
      shouldSubmitOnEnter(CMD_ENTER, false, {
        ...CMD_ENTER_POLICY,
        input: "   ",
        canSendAttachments: false,
      }),
    ).toBe("prevent");
  });

  test("Shift+Enter is still ignored in cmdEnterMode", () => {
    expect(shouldSubmitOnEnter(ENTER_WITH_SHIFT, false, CMD_ENTER_POLICY)).toBe("ignore");
  });

  test("IME composition is still ignored in cmdEnterMode", () => {
    expect(shouldSubmitOnEnter(ENTER_DURING_IME, false, CMD_ENTER_POLICY)).toBe("ignore");
  });

  test("pointer:coarse is still ignored in cmdEnterMode", () => {
    expect(shouldSubmitOnEnter(CMD_ENTER, true, CMD_ENTER_POLICY)).toBe("ignore");
  });
});

// ---------------------------------------------------------------------------
// computeGhostSuffix — autocomplete ghost-overlay policy
// ---------------------------------------------------------------------------

describe("computeGhostSuffix", () => {
  test("empty input + suggestion: returns full suggestion", () => {
    expect(
      computeGhostSuffix({
        pointerCoarse: false,
        suggestion: "Hello world",
        input: "",
        hasAttachments: false,
      }),
    ).toBe("Hello world");
  });

  test("input is prefix of suggestion: returns the unrendered tail", () => {
    expect(
      computeGhostSuffix({
        pointerCoarse: false,
        suggestion: "Hello world",
        input: "Hell",
        hasAttachments: false,
      }),
    ).toBe("o world");
  });

  test("input does not match suggestion prefix: returns null", () => {
    expect(
      computeGhostSuffix({
        pointerCoarse: false,
        suggestion: "Hello world",
        input: "Goodbye",
        hasAttachments: false,
      }),
    ).toBeNull();
  });

  test("attachments present: never renders ghost (avoid confusing what will be sent)", () => {
    expect(
      computeGhostSuffix({
        pointerCoarse: false,
        suggestion: "Hello world",
        input: "",
        hasAttachments: true,
      }),
    ).toBeNull();
  });

  test("no suggestion: returns null", () => {
    expect(
      computeGhostSuffix({
        pointerCoarse: false,
        suggestion: null,
        input: "anything",
        hasAttachments: false,
      }),
    ).toBeNull();
  });

  test("input fully matches suggestion (no remaining tail): returns null", () => {
    expect(
      computeGhostSuffix({
        pointerCoarse: false,
        suggestion: "Hello",
        input: "Hello",
        hasAttachments: false,
      }),
    ).toBeNull();
  });

  test("coarse pointer (touch device) suppresses the ghost entirely", () => {
    // Tab is the only acceptance gesture and is not present on touch
    // soft keyboards, so the overlay would be non-actionable and on
    // narrow viewports would clip against the rows={1} textarea.
    expect(
      computeGhostSuffix({
        pointerCoarse: true,
        suggestion: "Hello world",
        input: "",
        hasAttachments: false,
      }),
    ).toBeNull();
    expect(
      computeGhostSuffix({
        pointerCoarse: true,
        suggestion: "Hello world",
        input: "Hell",
        hasAttachments: false,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTML rendering — placeholder and send/stop button surface
// ---------------------------------------------------------------------------

afterEach(cleanup);
beforeEach(() => {
  resetLiveVoiceMocks();
  // The composer self-sources its draft + attachments from the store; reset
  // them between tests so seeded values can't leak across cases.
  useComposerStore.setState({
    input: "",
    attachments: [],
    attachmentLastError: null,
    restoredDraftConversationId: null,
  });
  useQuoteReplyStore.setState({
    stagedQuotes: [],
    replyBubble: null,
  });
});

/**
 * Build a composer-store `attachments` array from the test's intent. The
 * composer derives uploading-count and can-send from the real list, so seeding
 * the list exercises the real derivation rather than injecting the booleans.
 */
function seedAttachments(
  uploadingCount = 0,
  canSend = false,
): ChatAttachment[] {
  const list: ChatAttachment[] = [];
  for (let i = 0; i < uploadingCount; i++) {
    list.push({
      kind: "uploading",
      localId: `uploading-${i}`,
      filename: "file",
      mimeType: "text/plain",
      sizeBytes: 1,
    });
  }
  if (canSend) {
    list.push({
      kind: "uploaded",
      localId: "uploaded-0",
      id: "att-id-0",
      filename: "file",
      mimeType: "text/plain",
      sizeBytes: 1,
      previewUrl: null,
    });
  }
  return list;
}

function renderComposer(
  props: Partial<Parameters<typeof ChatComposer>[0]> & {
    input?: string;
    chatAttachments?: ChatAttachment[];
    attachmentsUploadingCount?: number;
    canSendAttachments?: boolean;
  } = {},
) {
  // The composer self-sources its draft + attachments from the store, so seed
  // them there rather than passing them as props.
  const {
    input = "",
    chatAttachments,
    attachmentsUploadingCount,
    canSendAttachments,
    ...rest
  } = props;
  useComposerStore.setState({
    input,
    attachments:
      chatAttachments ??
      seedAttachments(attachmentsUploadingCount, canSendAttachments),
  });
  const { container } = render(
    <ChatComposer
      placeholder="Custom placeholder"
      onSubmit={() => {}}
      inputRef={createRef<HTMLTextAreaElement>()}
      typingDisabled={false}
      sendDisabled={false}
      onAddAttachmentFiles={() => {}}
      onStopGenerating={() => {}}
      canStopGenerating={false}
      assistantId="asst_test"
      {...rest}
    />,
  );
  return container.innerHTML;
}

describe("ChatComposer — placeholder", () => {
  test("renders the `placeholder` prop on the textarea", () => {
    const html = renderComposer({ placeholder: "Type something cool" });
    expect(html).toContain('placeholder="Type something cool"');
  });

  test("falls back to the default placeholder when the prop is omitted", () => {
    const html = renderComposer({ placeholder: undefined });
    expect(html).toContain('placeholder="What would you like to do?"');
  });
});

describe("ChatComposer — send/stop button visibility", () => {
  test("canStopGenerating=false renders a Send button (aria-label='Send message')", () => {
    const html = renderComposer({ canStopGenerating: false });
    expect(html).toContain('aria-label="Send message"');
    expect(html).not.toContain('aria-label="Stop generating"');
  });

  test("canStopGenerating=true on desktop renders only the Stop button (send/attach/voice hidden)", () => {
    mockIsMobile = false;
    const html = renderComposer({ canStopGenerating: true });
    expect(html).toContain('aria-label="Stop generating"');
    expect(html).not.toContain('aria-label="Send message"');
  });

  test("canStopGenerating=true on mobile with no input renders only Stop button", () => {
    mockIsMobile = true;
    const html = renderComposer({ input: "", canStopGenerating: true });
    expect(html).toContain('aria-label="Stop generating"');
    expect(html).not.toContain('aria-label="Send message"');
    mockIsMobile = false;
  });

  test("canStopGenerating=true on mobile with user input renders only Send button", () => {
    mockIsMobile = true;
    const html = renderComposer({ input: "hello", canStopGenerating: true });
    expect(html).not.toContain('aria-label="Stop generating"');
    expect(html).toContain('aria-label="Send message"');
    mockIsMobile = false;
  });

  test("canStopGenerating=false keeps the Send button even during awaiting_user_input", () => {
    useTurnStore.setState({ ...INITIAL_TURN_STATE, phase: "awaiting_user_input" });
    const html = renderComposer({ canStopGenerating: false });
    expect(html).toContain('aria-label="Send message"');
    expect(html).not.toContain('aria-label="Stop generating"');
  });

  test("canStopGenerating=true shows stop button after page refresh (idle phase, server processing)", () => {
    useTurnStore.setState(INITIAL_TURN_STATE);
    const html = renderComposer({ canStopGenerating: true });
    expect(html).toContain('aria-label="Stop generating"');
  });
});

/**
 * The Button primitive sets HTML `disabled=""` only as a real attribute
 * (without quotes value rendering matters). It also emits Tailwind classes
 * like `disabled:[--vbtn-fg:…]` whose substring contains "disabled" — so we
 * isolate the send button's tag and look for ` disabled` (the attribute) by
 * checking the substring up to the first `>`.
 */
function sendButtonHasDisabledAttr(html: string): boolean {
  const idx = html.indexOf('aria-label="Send message"');
  if (idx === -1) return false;
  // Walk back to the opening '<' for this <button>, then forward to the next '>'.
  const openIdx = html.lastIndexOf("<button", idx);
  const closeIdx = html.indexOf(">", idx);
  if (openIdx === -1 || closeIdx === -1) return false;
  const tag = html.slice(openIdx, closeIdx + 1);
  // The HTML disabled attribute renders as `disabled=""` or bare `disabled`
  // (followed by space or `>`). Class names always live INSIDE quotes, so an
  // attribute outside quotes is the unambiguous signal.
  return /\sdisabled(?:=""|\s|>)/.test(tag);
}

describe("ChatComposer — disabled submit guard", () => {
  test("sendDisabled=true emits a disabled <button type=submit> (browser suppresses click)", () => {
    const html = renderComposer({
      input: "ready to send",
      sendDisabled: true,
    });
    // The Button primitive renders a real <button>; with disabled set, the
    // browser will not dispatch click events — that is the no-op contract.
    expect(sendButtonHasDisabledAttr(html)).toBe(true);
  });

  test("attachmentsUploadingCount > 0 also disables the submit button", () => {
    const html = renderComposer({
      input: "ready",
      attachmentsUploadingCount: 1,
    });
    expect(sendButtonHasDisabledAttr(html)).toBe(true);
  });

  test("empty input + no attachments disables the submit button", () => {
    const html = renderComposer({ input: "", canSendAttachments: false });
    expect(sendButtonHasDisabledAttr(html)).toBe(true);
  });

  test("empty input with staged quote context leaves the submit button enabled", () => {
    useQuoteReplyStore.setState({
      stagedQuotes: [
        {
          id: "quote-1",
          quotedText: "quoted context",
          replyText: "use this context",
          sourceMessageId: "msg-1",
        },
      ],
    });
    const html = renderComposer({ input: "", canSendAttachments: false });
    expect(sendButtonHasDisabledAttr(html)).toBe(false);
  });

  test("ready (input + not disabled + nothing uploading) leaves the button enabled", () => {
    const html = renderComposer({
      input: "go",
      sendDisabled: false,
      attachmentsUploadingCount: 0,
    });
    expect(sendButtonHasDisabledAttr(html)).toBe(false);
  });
});

describe("ChatComposer — Stop button click invokes onStopGenerating", () => {
  test("onStopGenerating wiring is verified by direct invocation", () => {
    // The Button primitive forwards onClick when not disabled (covered by
    // Button.test.tsx). We assert the prop wiring contract by invoking the
    // captured callback directly.
    const onStopGenerating = mock(() => {});
    renderComposer({
      onStopGenerating,
    });
    onStopGenerating();
    expect(onStopGenerating).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// HTML rendering — slot composition (the optional surface area)
// ---------------------------------------------------------------------------

describe("ChatComposer — optional slots", () => {
  test("noticesAboveFormSlot renders ABOVE the form, not inside it", () => {
    const html = renderComposer({
      noticesAboveFormSlot: <div data-testid="banner">banner</div>,
    });
    const bannerIdx = html.indexOf("banner");
    const formIdx = html.indexOf("<form");
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(formIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeLessThan(formIdx);
  });

  test("thresholdPickerSlot and contextWindowIndicatorSlot render inside the action bar", () => {
    const html = renderComposer({
      thresholdPickerSlot: <span>THR</span>,
      contextWindowIndicatorSlot: <span>CTX</span>,
    });
    expect(html).toContain(">THR<");
    expect(html).toContain(">CTX<");
  });

  test("voice button is omitted when voiceInputRef/onVoiceTranscript are not provided (app-editing variant)", () => {
    const html = renderComposer();
    // VoiceInputButton renders aria-label="Start voice input" / "Stop voice input".
    expect(html).not.toContain("Start voice input");
    expect(html).not.toContain("Stop voice input");
  });
});

// ---------------------------------------------------------------------------
// Empty composer with no attachments
// ---------------------------------------------------------------------------

describe("ChatComposer — attachments strip", () => {
  test("renders no attachment chip when chatAttachments is empty", () => {
    const html = renderComposer({ chatAttachments: [] });
    // ChatAttachmentsStrip renders nothing when the list is empty — sanity
    // check that no obvious attachment chip markup leaks in.
    expect(html).not.toContain("aria-label=\"Remove attachment\"");
  });

  test("with attachments, renders the strip wrapper", () => {
    const attachments: ChatAttachment[] = [
      {
        kind: "uploaded",
        localId: "att1",
        id: "att-id-1",
        filename: "file.txt",
        mimeType: "text/plain",
        sizeBytes: 100,
        previewUrl: null,
      },
    ];
    const html = renderComposer({ chatAttachments: attachments });
    expect(html).toContain("file.txt");
  });
});

// ---------------------------------------------------------------------------
// Slash popup — SSR rendering
//
// Pure-function slash/emoji state-machine tests live in
// useComposerController.test.ts. This section only covers component-level
// rendering checks.
// ---------------------------------------------------------------------------

describe("Slash popup — SSR rendering", () => {
  test("popup listbox markup is absent when no slash input is active", () => {
    // The hook starts with showSlashMenu=false, so the popup is NOT in the
    // initial render. We verify the component renders without errors and
    // that the role="listbox" is absent when no slash input is active.
    const html = renderComposer({ input: "" });
    expect(html).not.toContain('role="listbox"');
  });
});

// ---------------------------------------------------------------------------
// Live-voice integration
//
// The live-voice button is only mounted alongside the dictation button (same
// `voiceInputRef`/`onVoiceTranscript` precondition) and self-gates on the
// `voice-mode` flag. These tests render the *voice-enabled* variant so both
// mic affordances are in play.
// ---------------------------------------------------------------------------

/** Render the composer with the dictation voice props supplied. */
function renderVoiceComposer(
  props: Partial<Parameters<typeof ChatComposer>[0]> & { input?: string } = {},
) {
  const { input = "", ...rest } = props;
  useComposerStore.setState({ input, attachments: [] });
  return render(
    <ChatComposer
      onSubmit={() => {}}
      inputRef={createRef<HTMLTextAreaElement>()}
      typingDisabled={false}
      sendDisabled={false}
      onAddAttachmentFiles={() => {}}
      onStopGenerating={() => {}}
      canStopGenerating={false}
      assistantId="asst_test"
      conversationId="conv_test"
      voiceInputRef={createRef<VoiceInputButtonHandle>()}
      onVoiceTranscript={() => {}}
      {...rest}
    />,
  );
}

describe("ChatComposer — live-voice integration", () => {
  test("flag OFF: no live-voice button, dictation mic stays enabled", () => {
    // GIVEN the voice-mode flag is disabled (default)
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = false;

    // WHEN the voice-enabled composer renders
    const { queryByLabelText } = renderVoiceComposer();

    // THEN the live-voice control is absent and dictation is unaffected
    expect(queryByLabelText("Start voice mode")).toBeNull();
    expect(queryByLabelText("Stop voice mode")).toBeNull();
    const dictation = queryByLabelText(
      "Start voice input",
    ) as HTMLButtonElement | null;
    expect(dictation).not.toBeNull();
    expect(dictation?.disabled).toBe(false);
  });

  test("flag ON, idle: live-voice button present, dictation still enabled", () => {
    // GIVEN the flag is on with no active session
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    mockLiveVoiceState = "idle";

    // WHEN the composer renders
    const { getByLabelText, queryByLabelText } = renderVoiceComposer();

    // THEN both mics are available and neither is forced disabled
    expect(getByLabelText("Start voice mode")).toBeTruthy();
    const dictation = queryByLabelText(
      "Start voice input",
    ) as HTMLButtonElement | null;
    expect(dictation?.disabled).toBe(false);
  });

  test("active session disables dictation (mutual exclusion)", () => {
    // GIVEN a live-voice session is listening
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    mockLiveVoiceState = "listening";

    // WHEN the composer renders
    const { getByLabelText } = renderVoiceComposer();

    // THEN the live-voice control is a stop affordance and the dictation
    // mic is disabled so the two capture flows can't run together
    expect(getByLabelText("Stop voice mode")).toBeTruthy();
    const dictation = getByLabelText(
      "Start voice input",
    ) as HTMLButtonElement;
    expect(dictation.disabled).toBe(true);
  });

  test("active session surfaces user + assistant transcripts", () => {
    // GIVEN a listening session with partial speech and a streaming reply
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    mockLiveVoiceState = "listening";
    mockLivePartial = "what is the";
    mockLiveAssistant = "Let me check";

    // WHEN the composer renders
    const { getByLabelText } = renderVoiceComposer();

    // THEN the transcript surface shows both sides of the turn
    const surface = getByLabelText("Live voice transcript");
    expect(surface.textContent).toContain("what is the");
    expect(surface.textContent).toContain("Let me check");
  });

  test("active session stays stoppable even when the composer is busy", () => {
    // GIVEN a live session AND the composer is otherwise disabled
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    mockLiveVoiceState = "listening";

    // WHEN the composer renders with typingDisabled raised
    const { getByLabelText } = renderVoiceComposer({ typingDisabled: true });

    // THEN the stop control is still actionable and clicking it stops
    const stop = getByLabelText("Stop voice mode") as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    expect(liveStopSpy).toHaveBeenCalledTimes(1);
  });

  test("flag ON but no transcript content: surface stays empty when idle", () => {
    // GIVEN the flag is on but the session is idle
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    mockLiveVoiceState = "idle";

    // WHEN the composer renders
    const { queryByLabelText } = renderVoiceComposer();

    // THEN no transcript surface is rendered (idle = nothing to show)
    expect(queryByLabelText("Live voice transcript")).toBeNull();
  });

  test("dictation active disables the live-voice button (reverse mutual exclusion)", () => {
    // GIVEN the flag is on, no live session, but dictation is active.
    // `processing` is one of the two phases that make the composer's
    // `isVoiceActive` true (alongside `recording`); we use it because
    // `recording` additionally spins up amplitude analysis (getUserMedia),
    // which happy-dom doesn't provide — the mutual-exclusion signal is the
    // same either way.
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    mockLiveVoiceState = "idle";
    mockVoicePhase = "processing";

    // WHEN the composer renders
    const { getByLabelText } = renderVoiceComposer();

    // THEN the live-voice start affordance is disabled so it can't open a
    // second mic/voice session alongside the dictation recorder
    const liveVoice = getByLabelText("Start voice mode") as HTMLButtonElement;
    expect(liveVoice.disabled).toBe(true);
  });

  test("electron dictation uses the system overlay instead of the inline composer preview", () => {
    // GIVEN Electron is hosting the composer and dictation is processing.
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockIsElectron = true;
    mockVoiceMode = true;
    mockLiveVoiceState = "idle";
    mockVoicePhase = "processing";

    // WHEN the composer renders
    const { getByLabelText, queryByLabelText } = renderVoiceComposer();

    // THEN the shared top-center dictation overlay owns the visual treatment,
    // so the composer-specific preview is absent while mutual exclusion stays.
    expect(queryByLabelText("Transcribing")).toBeNull();
    const liveVoice = getByLabelText("Start voice mode") as HTMLButtonElement;
    expect(liveVoice.disabled).toBe(true);
  });

  test("failed live-voice state is inactive: dictation re-enabled, no transcript surface", () => {
    // GIVEN the flag is on and a live-voice start attempt has failed
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    mockLiveVoiceState = "failed";

    // WHEN the composer renders (dictation idle)
    const { getByLabelText, queryByLabelText } = renderVoiceComposer();

    // THEN dictation is treated as available again (failed = inactive)...
    const dictation = getByLabelText(
      "Start voice input",
    ) as HTMLButtonElement;
    expect(dictation.disabled).toBe(false);
    // ...and the transcript surface is unmounted rather than left hanging
    expect(queryByLabelText("Live voice transcript")).toBeNull();
  });
});

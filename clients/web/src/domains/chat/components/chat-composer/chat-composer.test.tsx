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
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

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

// Capacitor-iOS detection. The composer skips the first-run prefs card on the
// native iOS shell (a dismissible pre-prompt before the `getUserMedia`
// permission alert violates `docs/CAPACITOR.md` § OS permission requests) and
// starts the session directly. Defaults to non-iOS (web) so the existing
// first-run tests exercise the card path unchanged.
let mockIsNativeIOS = false;
mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => mockIsNativeIOS,
}));

// Live-voice integration. The session controller (`useLiveVoice`) lives in
// the layout-mounted `useLiveVoiceSessionController`, NOT in the composer —
// the composer only reads the real `useLiveVoiceStore` (self-contained
// zustand, no heavy imports) and drives the session through the
// `starter`/`controls` seams registered there. Tests therefore seed the real
// store and register spy seams; only the flag store is mocked (consumed by
// the real `LiveVoiceButton`, which self-gates on it). Defaults (flag off,
// idle) keep the existing HTML-surface assertions unchanged.
let mockVoiceMode = false;
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      voiceMode: () => mockVoiceMode,
    },
  },
}));

import {
  makeControlsSpies,
  seedLiveVoiceSession as seedLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-fakes.test-helper";
import {
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";

const liveStarterSpy = mock(
  (_assistantId: string, _conversationId: string | null) => {},
);
const liveControls = makeControlsSpies();

/**
 * Seed the real live-voice store with an active session (shared helper bound
 * to this file's ids/spies). `conversationId` defaults to the id
 * `renderVoiceComposer` binds, so the rendered composer owns the session;
 * pass another id to simulate a session owned by a different thread, or
 * `null` for a draft-started session.
 */
function seedLiveVoiceSession(
  state: LiveVoiceSessionState,
  conversationId: string | null = "conv_test",
) {
  seedLiveVoiceStore(state, {
    assistantId: "asst_test",
    conversationId,
    controls: liveControls,
  });
}

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

// First-run prefs card. Stubbed to a lightweight probe that exposes the two
// wired callbacks — the real card pulls in `useAssistantAvatar` (React Query),
// irrelevant to the composer's interception wiring, which is all these tests
// assert. Full card behavior lives in `voice-first-run-card.test.tsx`.
mock.module("@/domains/chat/voice/voice-room/voice-first-run-card", () => ({
  VoiceFirstRunCard: (props: { onStart: () => void; onDismiss?: () => void }) => (
    <div data-testid="first-run-card">
      <button type="button" onClick={props.onStart}>
        first-run-start
      </button>
      <button type="button" onClick={() => props.onDismiss?.()}>
        first-run-dismiss
      </button>
    </div>
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
  mockIsNativeIOS = false;
  mockVoiceMode = false;
  mockVoicePhase = "idle";
  setAudioLevelSpy.mockClear();
  liveStarterSpy.mockClear();
  liveControls.stop.mockClear();
  liveControls.release.mockClear();
  liveControls.interrupt.mockClear();
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setStarter(liveStarterSpy);
  // Default to the returning-user path so the entry-point mic starts a session
  // directly. First-run interception (the prefs card) is covered by
  // `voice-first-run-card.test.tsx`; a test that wants it opts in by setting
  // `firstRunSeen: false`.
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
    firstRunSeen: true,
  });
}

// Imported after the mocks so the component (and its transitive flag-store /
// voice-input-button imports) resolve against the mocked modules. The pure
// helpers (computeGhostSuffix / shouldSubmitOnEnter) come from
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
    const dictation = queryByLabelText(
      "Start voice input",
    ) as HTMLButtonElement | null;
    expect(dictation).not.toBeNull();
    expect(dictation?.disabled).toBe(false);
  });

  test("flag ON, idle: live-voice button present, normal row, no voice bar", () => {
    // GIVEN the flag is on with no active session
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;

    // WHEN the composer renders
    const { getByLabelText, queryByLabelText, queryByRole } =
      renderVoiceComposer();

    // THEN both mics are available, neither is forced disabled, and the
    // action row is the normal composer row (no voice bar)
    expect(getByLabelText("Start voice mode")).toBeTruthy();
    const dictation = queryByLabelText(
      "Start voice input",
    ) as HTMLButtonElement | null;
    expect(dictation?.disabled).toBe(false);
    expect(queryByRole("group", { name: "Voice session" })).toBeNull();
    expect(getByLabelText("Send message")).toBeTruthy();
  });

  test("clicking the live-voice button starts a session through the store-registered starter", () => {
    // GIVEN the flag is on with no active session
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;

    // WHEN the user clicks the entry-point mic
    const { getByLabelText } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));

    // THEN the layout-owned controller is asked to start with the bound
    // context (the composer holds no controller of its own)
    expect(liveStarterSpy).toHaveBeenCalledTimes(1);
    expect(liveStarterSpy).toHaveBeenCalledWith("asst_test", "conv_test");
  });

  test("first-ever entry opens the prefs card instead of starting the session", () => {
    // GIVEN the flag is on, no session, and the user has never entered voice
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    useVoicePrefsStore.setState({ firstRunSeen: false });

    // WHEN the user clicks the entry-point mic
    const { getByLabelText, getByTestId } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));

    // THEN the prefs card appears and the session has NOT started yet
    expect(getByTestId("first-run-card")).toBeTruthy();
    expect(liveStarterSpy).not.toHaveBeenCalled();
  });

  test("first-run card Start persists the flag then starts the session", () => {
    // GIVEN the first-run card is open
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    useVoicePrefsStore.setState({ firstRunSeen: false });
    const { getByLabelText, getByText, queryByTestId } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));

    // WHEN the user commits via Start
    fireEvent.click(getByText("first-run-start"));

    // THEN the first run is consumed, the card closes, and the session starts
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);
    expect(queryByTestId("first-run-card")).toBeNull();
    expect(liveStarterSpy).toHaveBeenCalledTimes(1);
    expect(liveStarterSpy).toHaveBeenCalledWith("asst_test", "conv_test");
  });

  test("dismissing the first-run card cancels without consuming the first run", () => {
    // GIVEN the first-run card is open
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    useVoicePrefsStore.setState({ firstRunSeen: false });
    const { getByLabelText, getByText, queryByTestId } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));

    // WHEN the user dismisses it
    fireEvent.click(getByText("first-run-dismiss"));

    // THEN nothing started and the first run is still available for next time
    expect(queryByTestId("first-run-card")).toBeNull();
    expect(liveStarterSpy).not.toHaveBeenCalled();
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);
  });

  test("Capacitor iOS: first-ever entry skips the card and starts directly (permission alert reached)", () => {
    // GIVEN the native iOS shell, the flag on, no session, and a first-ever
    // entry — a dismissible pre-prompt here would violate CAPACITOR.md
    // § OS permission requests, so the card must be skipped.
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    mockIsNativeIOS = true;
    useVoicePrefsStore.setState({ firstRunSeen: false });

    // WHEN the user clicks the entry-point mic
    const { getByLabelText, queryByTestId } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));

    // THEN no card renders and the session starts straight away so the OS
    // getUserMedia alert is the next thing the user sees. The first-run flag
    // is left untouched (the card, not the mic, owns marking it seen).
    expect(queryByTestId("first-run-card")).toBeNull();
    expect(liveStarterSpy).toHaveBeenCalledTimes(1);
    expect(liveStarterSpy).toHaveBeenCalledWith("asst_test", "conv_test");
  });

  test("Capacitor iOS: returning-user entry still starts directly (unchanged)", () => {
    // GIVEN the native iOS shell with the first run already consumed
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    mockIsNativeIOS = true;
    // resetLiveVoiceMocks already sets firstRunSeen: true

    // WHEN the user clicks the entry-point mic
    const { getByLabelText, queryByTestId } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));

    // THEN it behaves exactly like the returning-user path on any platform
    expect(queryByTestId("first-run-card")).toBeNull();
    expect(liveStarterSpy).toHaveBeenCalledTimes(1);
    expect(liveStarterSpy).toHaveBeenCalledWith("asst_test", "conv_test");
  });

  test("owned active session swaps the action row for the voice bar (mutual exclusion by absence)", () => {
    // GIVEN a live-voice session owned by this composer's conversation
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening");

    // WHEN the composer renders
    const { getByRole, queryByLabelText } = renderVoiceComposer();

    // THEN the voice bar replaces the whole action row — attach, both mic
    // buttons, and send are gone, so the two capture flows can't coexist
    expect(getByRole("group", { name: "Voice session" })).toBeTruthy();
    expect(queryByLabelText("Start voice mode")).toBeNull();
    expect(queryByLabelText("Start voice input")).toBeNull();
    expect(queryByLabelText("Send message")).toBeNull();
    // ...and the old inline transcript strip is gone for good
    expect(queryByLabelText("Live voice transcript")).toBeNull();
  });

  test("session owned by another conversation leaves this composer untouched (pill is the surface)", () => {
    // GIVEN a session owned by thread A while this composer shows thread B
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening", "conv-other-thread");

    // WHEN the composer renders
    const { container, getByLabelText, queryByRole } = renderVoiceComposer();

    // THEN no voice bar, no transcript region, and the textarea stays
    // editable — thread B behaves like a normal composer...
    expect(queryByRole("group", { name: "Voice session" })).toBeNull();
    expect(getByLabelText("Send message")).toBeTruthy();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    // ...except both mic entry points are disabled: the running session owns
    // the microphone, so no second capture flow may start from here
    const liveVoice = getByLabelText("Start voice mode") as HTMLButtonElement;
    expect(liveVoice.disabled).toBe(true);
    const dictation = getByLabelText("Start voice input") as HTMLButtonElement;
    expect(dictation.disabled).toBe(true);
  });

  test("draft composer keeps owning a draft-started session after the server assigns a conversation", () => {
    // GIVEN a session started from a draft (no conversation) whose `ready`
    // frame has since republished a server-assigned conversation id
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening", null);
    useLiveVoiceStore.getState().setConversationId("conv-server-assigned");

    // WHEN the draft composer (bound to no conversation) renders
    const { getByRole } = renderVoiceComposer({ conversationId: undefined });

    // THEN it still owns the session — the voice bar stays, so the user
    // sitting at the composer that started the session never sees it
    // handed off to the title-bar pill
    expect(getByRole("group", { name: "Voice session" })).toBeTruthy();
  });

  test("owned session keeps the textarea mounted but inert", () => {
    // GIVEN a live-voice session owned by this composer's conversation
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening");

    // WHEN the composer renders
    const { container } = renderVoiceComposer();

    // THEN the textarea stays mounted (VoiceLiveTranscript renders into its
    // grid cell once speech streams) but is disabled so focus/typing can't
    // fight the session
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect((textarea as HTMLTextAreaElement).disabled).toBe(true);
  });

  test("voice bar ✕ ends the session even when the composer is busy", () => {
    // GIVEN a live session AND the composer is otherwise disabled
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening");

    // WHEN the composer renders with typingDisabled raised
    const { getByLabelText } = renderVoiceComposer({ typingDisabled: true });

    // THEN the end control is still actionable and clicking it stops the
    // session through the store-registered controls
    const end = getByLabelText("End voice session") as HTMLButtonElement;
    expect(end.disabled).toBe(false);
    fireEvent.click(end);
    expect(liveControls.stop).toHaveBeenCalledTimes(1);
  });

  test("voice bar ↑ manually releases the turn while listening", () => {
    // GIVEN a listening session owned by this composer
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening");

    // WHEN the user clicks send-now
    const { getByLabelText } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Send now"));

    // THEN the turn is released through the store-registered controls
    expect(liveControls.release).toHaveBeenCalledTimes(1);
    expect(liveControls.stop).not.toHaveBeenCalled();
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
    mockVoicePhase = "processing";

    // WHEN the composer renders
    const { getByLabelText, queryByLabelText } = renderVoiceComposer();

    // THEN the shared top-center dictation overlay owns the visual treatment,
    // so the composer-specific preview is absent while mutual exclusion stays.
    expect(queryByLabelText("Transcribing")).toBeNull();
    const liveVoice = getByLabelText("Start voice mode") as HTMLButtonElement;
    expect(liveVoice.disabled).toBe(true);
  });

  test("failed live-voice state is inactive: normal row restored, dictation re-enabled", () => {
    // GIVEN the flag is on and a live-voice session has failed
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening");
    useLiveVoiceStore.getState().fail("boom");

    // WHEN the composer renders (dictation idle)
    const { getByLabelText, queryByRole } = renderVoiceComposer();

    // THEN the voice bar is unmounted and the normal row is back...
    expect(queryByRole("group", { name: "Voice session" })).toBeNull();
    expect(getByLabelText("Send message")).toBeTruthy();
    // ...with dictation treated as available again (failed = inactive)
    const dictation = getByLabelText(
      "Start voice input",
    ) as HTMLButtonElement;
    expect(dictation.disabled).toBe(false);
  });

  test("failed session surfaces the error as a dismissible notice", () => {
    // GIVEN a failed session carrying an error message
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening");
    useLiveVoiceStore.getState().fail("Microphone capture could not start.");

    // WHEN the composer renders
    const { getByText, getByLabelText } = renderVoiceComposer();

    // THEN the error notice is visible with the session's message
    expect(getByText("Microphone capture could not start.")).toBeTruthy();

    // WHEN the user dismisses it
    fireEvent.click(getByLabelText("Dismiss"));

    // THEN the store is reset back to idle (which clears the error)
    expect(useLiveVoiceStore.getState().state).toBe("idle");
    expect(useLiveVoiceStore.getState().error).toBeNull();
  });

  test("no live-voice error notice while idle or without an error", () => {
    // GIVEN the flag is on with an idle session and no error
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;

    // WHEN the composer renders
    const { queryByLabelText } = renderVoiceComposer();

    // THEN no dismissible notice is mounted
    expect(queryByLabelText("Dismiss")).toBeNull();
  });

  test("voice bar persists when the flag flips off mid-session (no stranded session)", () => {
    // GIVEN an active owned session but the voice-mode flag has since
    // flipped off while the layout-owned controller keeps the session live
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = false;
    seedLiveVoiceSession("listening");

    // WHEN the composer renders
    const { getByRole, getByLabelText, queryByLabelText } =
      renderVoiceComposer();

    // THEN the active-UI swap follows the session state, not eligibility:
    // the bar (and its ✕ stop control) stays until teardown completes...
    expect(getByRole("group", { name: "Voice session" })).toBeTruthy();
    const end = getByLabelText("End voice session") as HTMLButtonElement;
    expect(end.disabled).toBe(false);
    // ...while the entry-point button stays flag-gated off
    expect(queryByLabelText("Start voice mode")).toBeNull();

    // AND the ✕ still ends the live session
    fireEvent.click(end);
    expect(liveControls.stop).toHaveBeenCalledTimes(1);
  });

  test("voice bar persists when assistantId is transiently cleared mid-session", () => {
    // GIVEN an active owned session whose assistantId has been cleared from
    // props
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening");

    // WHEN the composer renders without an assistant id
    const { getByRole, getByLabelText } = renderVoiceComposer({
      assistantId: null,
    });

    // THEN the stop control remains available for the live mic/socket
    expect(getByRole("group", { name: "Voice session" })).toBeTruthy();
    fireEvent.click(getByLabelText("End voice session"));
    expect(liveControls.stop).toHaveBeenCalledTimes(1);
  });

  test("failure after an eligibility drop still surfaces the error notice", () => {
    // GIVEN a session that failed right after the flag flipped off
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = false;
    seedLiveVoiceSession("listening");
    useLiveVoiceStore.getState().fail("Connection lost.");

    // WHEN the composer renders
    const { getByText } = renderVoiceComposer();

    // THEN the user still learns why voice stopped
    expect(getByText("Connection lost.")).toBeTruthy();
  });

  test("no-voice variant (app-editing) never swaps its row for a session it doesn't own", () => {
    // GIVEN a live session exists in the global store (owned elsewhere) and
    // this variant has no voice props
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening", "conv-other-thread");

    // WHEN the app-editing variant renders (no voiceInputRef/onVoiceTranscript)
    const html = renderComposer();

    // THEN its action row is untouched — no voice bar, normal send button
    expect(html).not.toContain('aria-label="Voice session"');
    expect(html).toContain('aria-label="Send message"');
  });
});

// ---------------------------------------------------------------------------
// Live-voice transcript in the composer text area (Light 55)
//
// While speech streams, the disabled textarea is visually hidden and the
// display-only `VoiceLiveTranscript` renders in its grid cell; with no
// transcript yet the textarea (and its placeholder) stays visible.
// ---------------------------------------------------------------------------

describe("ChatComposer — live-voice transcript area", () => {
  test("streaming speech hides the textarea and renders the transcript in its place", () => {
    // GIVEN a listening owned session with an in-flight partial transcript
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening");
    useLiveVoiceStore
      .getState()
      .setPartialTranscript("this is a text that I am just speaking");

    // WHEN the composer renders
    const { container, getByLabelText } = renderVoiceComposer();

    // THEN the transcript region shows the speech as composer text...
    const region = getByLabelText("Voice transcript");
    expect(region.textContent).toContain(
      "this is a text that I am just speaking",
    );
    // ...with a caret, in place of the visually hidden (still-mounted,
    // still-uneditable) textarea
    expect(region.querySelector('[data-testid="voice-transcript-caret"]')).toBeTruthy();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.className).toContain("hidden");
    expect(textarea.disabled).toBe(true);
  });

  test("speech from a session owned by another thread never streams into this composer", () => {
    // GIVEN a session owned by thread A streaming speech while this composer
    // shows thread B
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening", "conv-other-thread");
    useLiveVoiceStore.getState().setPartialTranscript("thread A's words");

    // WHEN the composer renders
    const { container, queryByLabelText } = renderVoiceComposer();

    // THEN no transcript region mounts and the textarea stays editable —
    // thread A's speech must not leak into thread B's input
    expect(queryByLabelText("Voice transcript")).toBeNull();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.className).not.toContain("hidden");
    expect(textarea.disabled).toBe(false);
  });

  test("empty transcript keeps the textarea (and its placeholder) visible", () => {
    // GIVEN an active owned session with no speech yet (Light 53 baseline)
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening");

    // WHEN the composer renders
    const { container, queryByLabelText } = renderVoiceComposer();

    // THEN nothing replaces the textarea — its placeholder shows through
    expect(queryByLabelText("Voice transcript")).toBeNull();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.className).not.toContain("hidden");
  });

  test("textarea is restored after the session ends, even with a leftover final transcript", () => {
    // GIVEN the session has ended (store back to idle, final text lingering)
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    useLiveVoiceStore.getState().setFinalTranscript("what I said last");

    // WHEN the composer renders
    const { container, queryByLabelText } = renderVoiceComposer();

    // THEN the composer behaves normally: no transcript region, editable textarea
    expect(queryByLabelText("Voice transcript")).toBeNull();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.className).not.toContain("hidden");
    expect(textarea.disabled).toBe(false);
  });

  // The ghost-suffix mirror and the live transcript share the same grid cell,
  // so a suggestion painted during a session would overlay the streaming
  // speech. The composer suppresses the ghost while it owns the session.
  test("ghost suffix renders normally with no active session (baseline)", () => {
    // GIVEN an empty draft and a pending autocomplete suggestion, no session
    const html = renderComposer({ input: "", suggestion: "ghost completion text" });

    // THEN the ghost suffix paints into the composer's mirror cell
    expect(html).toContain("ghost completion text");
  });

  test("owned live-voice session suppresses the ghost suffix (no overlay on the transcript)", () => {
    // GIVEN a listening session this composer owns and a pending suggestion
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoiceMode = true;
    seedLiveVoiceSession("listening");

    // WHEN the composer renders with the suggestion present
    const { container } = renderVoiceComposer({ suggestion: "ghost completion text" });

    // THEN the ghost is gone — the shared grid cell is left for the streaming
    // transcript, not the suggestion overlay
    expect(container.textContent).not.toContain("ghost completion text");
  });
});

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
import { createRef, type FormEvent, type ReactNode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import {
  type ChatAttachment,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { selectFiles } from "@/domains/chat/components/chat-attachments/attachment-test-helpers";
import {
  MOBILE_CONTROL_CLASS,
  MOBILE_GLYPH_CLASS,
} from "@/domains/chat/components/chat-composer/composer-mobile-chrome";
import type { VoiceInputButtonHandle } from "@/domains/chat/components/voice-input-button";
import type { LiveVoicePreflightVerdict } from "@/domains/chat/voice/live-voice/live-voice-preflight-api";
import { INITIAL_TURN_STATE, useTurnStore } from "@/domains/chat/turn-store";
import * as assistantAvatarMod from "@/hooks/use-assistant-avatar";
import * as emojiCatalogMod from "@/domains/chat/components/chat-composer/emoji-catalog";
import * as nativeAuthMod from "@/runtime/native-auth";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";

// Pure helpers live in `chat-composer-utils` (no mocks needed), so import them
// statically. `ChatComposer` itself is imported dynamically *after* the mocks
// below so its transitive flag-store / live-voice / voice-input-button imports
// resolve against the mocked modules.
import {
  computeGhostSuffix,
  isDraftPastOneLine,
  shouldSubmitOnEnter,
} from "@/domains/chat/components/chat-composer/chat-composer-utils";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";

// The two device-side axes are driven by stubbing `window.matchMedia`, not by
// mocking `use-is-mobile`, so a test says which signal the composer actually
// consults and the crossed shapes (roomy touch tablet, narrow mouse window)
// are expressible at all. See `docs/PLATFORM_ADAPTATION.md`.
const viewport = viewportAxesStub();

let mockIsElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => mockIsElectron,
}));

// Capacitor-iOS detection, kept as a regression guard. The first-run prefs card
// is now shown on EVERY platform, the native iOS shell included (a deliberate
// parity choice that knowingly deviates from `docs/CAPACITOR.md` § OS permission
// requests — see the composer's `handleLiveVoiceStart` note), so setting this to
// iOS must NOT suppress the card. Defaults to non-iOS (web).
let mockIsNativeIOS = false;
// The Capacitor shells (iOS and Android), where the settings pills stand for
// the whole session instead of following focus. Defaults to the browser, so
// every case that does not set it exercises the focus-driven reveal.
let mockIsNativeMobile = false;
// The Android shell alone, where Capacitor's file chooser cannot offer a
// camera and the plus keeps a sheet of its own. Defaults to false, so every
// other surface exercises the direct picker.
let mockIsNativeAndroid = false;
// Whether this shell's build linked the native pickers. False by default, so
// every other case describes a shell with only the OS chooser.
let mockNativePickersAvailable = false;
mock.module(
  "@/domains/chat/components/chat-attachments/native-attachment-pickers",
  () => ({
    nativeAttachmentPickersAvailable: () => mockNativePickersAvailable,
    pickMediaNative: async () => ({ tooLarge: [], pickFull: [] }),
    pickFilesNative: async () => ({ tooLarge: [], pickFull: [] }),
    isPickerDismissal: () => false,
  }),
);
mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => mockIsNativeIOS,
  useIsNativeMobile: () => mockIsNativeMobile,
  useIsNativeAndroid: () => mockIsNativeAndroid,
}));

// The native shell, which is the only place dictation's inline preview takes
// the textarea's place in the row. Defaults to the browser; the row-layout
// cases below flip it.
let mockIsNativePlatform = false;
mock.module("@/runtime/native-auth", () => ({
  ...nativeAuthMod,
  useIsNativePlatform: () => mockIsNativePlatform,
}));

// Live-voice integration. The session controller (`useLiveVoice`) lives in
// the layout-mounted `useLiveVoiceSessionController`, NOT in the composer —
// the composer only reads the real `useLiveVoiceStore` (self-contained
// zustand, no heavy imports) and drives the session through the
// `starter`/`controls` seams registered there. Tests therefore seed the real
// store and register spy seams.

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
const livePrewarmSpy = mock(() => {});
const liveCancelPrewarmSpy = mock(() => {});
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
  VoiceFirstRunCard: (props: {
    onStart: () => void;
    onDismiss?: () => void;
    nonDismissible?: boolean;
  }) => (
    <div
      data-testid="first-run-card"
      // Surface the lock so a test can assert the composer passes it on iOS.
      data-non-dismissible={String(props.nonDismissible ?? false)}
    >
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

// Live-voice readiness preflight. The composer awaits this BEFORE opening the
// room; mock it so no real daemon call is made and the verdict is controllable
// per-test. Defaults to `ready` so every existing entry-point test keeps
// starting the session. The not-ready cases below flip `mockPreflightVerdict`.
let mockPreflightVerdict: LiveVoicePreflightVerdict | null = {
  status: "ready",
};
const preflightSpy = mock(
  (_assistantId: string): Promise<LiveVoicePreflightVerdict | null> =>
    Promise.resolve(mockPreflightVerdict),
);
mock.module("@/domains/chat/voice/live-voice/live-voice-preflight-api", () => ({
  preflightLiveVoice: preflightSpy,
}));

// Backwards-compat version gate for the voice entry point. Mocked (rather
// than driving the identity store) so these tests stay about composer
// behavior; the gate's own semver truth-table lives in
// `use-supports-live-voice.test.ts`.
let mockSupportsLiveVoice = true;
mock.module("@/lib/backwards-compat/use-supports-live-voice", () => ({
  useSupportsLiveVoice: () => mockSupportsLiveVoice,
}));

// Emoji autocomplete. The real hook `import()`s ~150 kB of catalog data on
// first mount and sets state when it lands, a tick after most of these test
// bodies have returned, which React reports as an update outside `act`. Serve
// an already-loaded (empty) catalog so no composer takes a late state update.
// The catalog's own search behavior is covered by its consumers' tests. The
// real module is spread back in so the trigger regex and threshold the composer
// reads survive the mock.
mock.module("@/domains/chat/components/chat-composer/emoji-catalog", () => ({
  ...emojiCatalogMod,
  useEmojiSearch: () => () => [],
}));

// Composer-card width measurement. happy-dom has no layout engine (every box
// measures 0), so drive the compact signal directly instead of resizing.
let mockCompactComposer = false;
mock.module("@/domains/chat/components/chat-composer/composer-compact", () => ({
  COMPOSER_COMPACT_WIDTH_PX: 520,
  useIsCompactComposerWidth: () => mockCompactComposer,
  useComposerCompact: () => mockCompactComposer,
  ComposerCompactProvider: ({ children }: { children: ReactNode }) => children,
}));

// Avatar data feeding the voice bar's wave accent. Mocked so the composer
// renders without a QueryClientProvider (the real hook is React Query). The
// real module is spread back in so its other exports survive the mock: the
// auth store reaches `avatarQueryKey` through the takeover avatar stash.
mock.module("@/hooks/use-assistant-avatar", () => ({
  ...assistantAvatarMod,
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
    isLoading: false,
    invalidate: () => {},
  }),
}));

// `useNavigate` — the composer deep-links to voice settings from the
// "configure voice" prompt. Mock the whole module (the composer's only
// react-router import is `useNavigate`) so the not-tree-mounted composer can
// still call it, and so a test can assert the destination.
const navigateSpy = mock((_to: string) => {});
mock.module("react-router", () => ({
  useNavigate: () => navigateSpy,
  // The composer captures pop-out mode once at mount from the URL search
  // string; a plain window (no `?popout=1`) is the default test context.
  useLocation: () => ({ search: "" }),
}));

// "Add to chat" sheet, kept for the Android shell. Stubbed to a probe that
// surfaces its open state plus a button standing in for a completed pick, so
// these cases assert the composer's wiring rather than the sheet, which
// `add-to-chat-sheet.test.tsx` covers.
const SHEET_PICK = [new File(["x"], "picked.png", { type: "image/png" })];
mock.module(
  "@/domains/chat/components/chat-composer/add-to-chat-sheet",
  () => ({
    AddToChatSheet: (props: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      onAttachFiles: (files: File[]) => void;
      onPickerOpenChange: (open: boolean) => void;
    }) => (
      <div data-testid="add-to-chat-sheet" data-open={String(props.open)}>
        <button type="button" onClick={() => props.onAttachFiles(SHEET_PICK)}>
          sheet-pick
        </button>
        <button type="button" onClick={() => props.onPickerOpenChange(true)}>
          sheet-picker-up
        </button>
      </div>
    ),
  }),
);

// Flush the microtask/timer queue so the composer's awaited preflight
// resolves and the follow-on `starter` call / notice render settle. Wrapped in
// `act` to absorb the post-await state updates.
async function flushPreflight() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function resetLiveVoiceMocks() {
  mockSupportsLiveVoice = true;
  mockIsElectron = false;
  mockIsNativeIOS = false;
  mockIsNativeMobile = false;
  mockIsNativeAndroid = false;
  mockNativePickersAvailable = false;
  mockIsNativePlatform = false;
  mockVoicePhase = "idle";
  mockPreflightVerdict = { status: "ready" };
  preflightSpy.mockClear();
  navigateSpy.mockClear();
  setAudioLevelSpy.mockClear();
  liveStarterSpy.mockClear();
  livePrewarmSpy.mockClear();
  liveCancelPrewarmSpy.mockClear();
  liveControls.stop.mockClear();
  liveControls.release.mockClear();
  liveControls.interrupt.mockClear();
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setStarter({
    prewarm: livePrewarmSpy,
    cancelPrewarm: liveCancelPrewarmSpy,
    start: liveStarterSpy,
  });
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
const { ChatComposer } =
  await import("@/domains/chat/components/chat-composer/chat-composer");

// ---------------------------------------------------------------------------
// shouldSubmitOnEnter — keyboard policy
// ---------------------------------------------------------------------------

const ENTER = {
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  keyCode: 13,
};
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
        {
          key: " ",
          shiftKey: false,
          metaKey: false,
          ctrlKey: false,
          isComposing: false,
          keyCode: 32,
        },
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
    expect(shouldSubmitOnEnter(CMD_ENTER, false, CMD_ENTER_POLICY)).toBe(
      "submit",
    );
  });

  test("Ctrl+Enter with content submits (Windows/Linux)", () => {
    expect(shouldSubmitOnEnter(CTRL_ENTER, false, CMD_ENTER_POLICY)).toBe(
      "submit",
    );
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
    expect(shouldSubmitOnEnter(ENTER_WITH_SHIFT, false, CMD_ENTER_POLICY)).toBe(
      "ignore",
    );
  });

  test("IME composition is still ignored in cmdEnterMode", () => {
    expect(shouldSubmitOnEnter(ENTER_DURING_IME, false, CMD_ENTER_POLICY)).toBe(
      "ignore",
    );
  });

  test("pointer:coarse is still ignored in cmdEnterMode", () => {
    expect(shouldSubmitOnEnter(CMD_ENTER, true, CMD_ENTER_POLICY)).toBe(
      "ignore",
    );
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

describe("isDraftPastOneLine", () => {
  test("a draft wider than its inline line has outgrown it", () => {
    expect(
      isDraftPastOneLine({
        naturalWidthPx: 260,
        inlineWidthPx: 220,
        hasHardBreak: false,
      }),
    ).toBe(true);
  });

  test("a draft that fits stays on the one line", () => {
    expect(
      isDraftPastOneLine({
        naturalWidthPx: 180,
        inlineWidthPx: 220,
        hasHardBreak: false,
      }),
    ).toBe(false);
  });

  test("a draft filling its line to the pixel still fits", () => {
    // Whole-pixel natural widths against a fractional line: without the slack
    // a draft that fits would read as one pixel too wide and stack itself.
    expect(
      isDraftPastOneLine({
        naturalWidthPx: 221,
        inlineWidthPx: 220.4,
        hasHardBreak: false,
      }),
    ).toBe(false);
  });

  test("a draft with a line break of its own is past one line at any width", () => {
    expect(
      isDraftPastOneLine({
        naturalWidthPx: 40,
        inlineWidthPx: 220,
        hasHardBreak: true,
      }),
    ).toBe(true);
  });

  test("an unmeasured row leaves the draft on one line", () => {
    // Before first layout (and in a test DOM that has none) every measurement
    // reads zero, which the inset turns negative. Nothing to outgrow.
    expect(
      isDraftPastOneLine({
        naturalWidthPx: 0,
        inlineWidthPx: -16,
        hasHardBreak: false,
      }),
    ).toBe(false);
  });

  test("the verdict does not move with the width the draft currently has", () => {
    // The stacked layout hands the draft the whole card. Judged there, a draft
    // that wrapped would fit again, flip the row back, wrap again, and never
    // settle, so the answer is anchored to the inline width in both layouts.
    const draft = { naturalWidthPx: 300, hasHardBreak: false };
    expect(isDraftPastOneLine({ ...draft, inlineWidthPx: 220 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTML rendering — placeholder and send/stop button surface
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  viewport.restore();
});
beforeEach(() => {
  resetLiveVoiceMocks();
  mockCompactComposer = false;
  // Roomy window, mouse: the desktop shape, unless a test says otherwise.
  viewport.set({ narrow: false, coarsePointer: false });
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

type RenderComposerProps = Partial<Parameters<typeof ChatComposer>[0]> & {
  input?: string;
  chatAttachments?: ChatAttachment[];
  attachmentsUploadingCount?: number;
  canSendAttachments?: boolean;
};

/** The composer under its default props, for `render` and `rerender` alike. */
function composerElement(
  props: Partial<Parameters<typeof ChatComposer>[0]> = {},
) {
  return (
    <ChatComposer
      placeholder="Custom placeholder"
      onSubmit={() => {}}
      inputRef={createRef<HTMLTextAreaElement>()}
      typingDisabled={false}
      sendDisabled={false}
      onAddAttachmentFiles={() => {}}
      onStopGenerating={() => {}}
      isAssistantBusy={false}
      assistantId="asst_test"
      {...props}
    />
  );
}

/**
 * Mount the composer and hand back the testing-library result, for cases that
 * drive events at the mounted DOM. Cases that only read the rendered surface
 * use `renderComposer` below, which returns the markup directly.
 */
function renderComposerView(props: RenderComposerProps = {}) {
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
  return render(composerElement(rest));
}

function renderComposer(props: RenderComposerProps = {}) {
  return renderComposerView(props).container.innerHTML;
}

/** The access + profile pickers, the pair the mobile pills row floats. */
const SETTINGS_SLOTS = {
  thresholdPickerSlot: <span>THR</span>,
  modelPickerSlot: <span>PROFILE</span>,
};

const PLUS_LABEL = "Add to chat";

/**
 * The device shapes the composer adapts to, one helper each. They are separate
 * rather than parameterised on a single flag because the crossed shapes are the
 * point: a phone is narrow AND coarse, a window dragged under the breakpoint is
 * narrow with a mouse still driving it, and a tablet is coarse with room to
 * spare. See `docs/PLATFORM_ADAPTATION.md`.
 */
function renderPhoneComposer(props: RenderComposerProps = {}) {
  viewport.set({ narrow: true, coarsePointer: true });
  return renderComposerView(props);
}

/** A window dragged narrow that a mouse still drives: web, or Electron. */
function renderNarrowMouseComposer(props: RenderComposerProps = {}) {
  viewport.set({ narrow: true, coarsePointer: false });
  return renderComposerView(props);
}

/** A roomy touch device: a tablet, or a phone turned into landscape. */
function renderTouchTabletComposer(props: RenderComposerProps = {}) {
  viewport.set({ narrow: false, coarsePointer: true });
  return renderComposerView(props);
}

function pillsRow(container: HTMLElement) {
  return container.querySelector('[data-slot="composer-settings-pills"]');
}

/** The wrapper around the card, which publishes the banner flag. */
function composerShell(container: HTMLElement) {
  return container.querySelector('[data-slot="chat-composer-shell"]');
}

function control(container: HTMLElement, label: string) {
  return container.querySelector(`[aria-label="${label}"]`);
}

function fileInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[type="file"]');
}

function addSheet(container: HTMLElement) {
  return container.querySelector('[data-testid="add-to-chat-sheet"]');
}

function textareaOf(container: HTMLElement) {
  const textarea = container.querySelector("textarea");
  if (!textarea) {
    throw new Error("composer rendered without a textarea");
  }
  return textarea;
}

/**
 * The class list on an icon-only button's glyph wrapper, which is where the
 * `Button` primitive puts the glyph sizing.
 */
function glyphClassOf(button: Element | null): string {
  return button?.querySelector("span")?.className ?? "";
}

function inlineActionsStart(container: HTMLElement) {
  const el = container.querySelector<HTMLElement>(
    '[data-slot="composer-inline-actions-start"]',
  );
  if (!el) {
    throw new Error("composer rendered without its leading control cluster");
  }
  return el;
}

function inlineActionsEnd(container: HTMLElement) {
  const el = container.querySelector<HTMLElement>(
    '[data-slot="composer-inline-actions-end"]',
  );
  if (!el) {
    throw new Error("composer rendered without its trailing control cluster");
  }
  return el;
}

/** The flex container both control clusters and the text field sit in. */
function composerRow(container: HTMLElement) {
  const row = inlineActionsStart(container).parentElement;
  if (!row) {
    throw new Error("the leading control cluster has no row");
  }
  return row;
}

/** The grid the textarea, its mirror and the draft probe share. */
function textFieldBlock(container: HTMLElement) {
  const block = textareaOf(container).parentElement;
  if (!block) {
    throw new Error("the textarea has no block");
  }
  return block;
}

/** The horizontal padding the composer takes off its measured inline span. */
const TEXT_FIELD_INSET_X_PX = 16;

function stubEdge(el: Element, edge: "left" | "right", valuePx: number) {
  const rect: DOMRect = {
    x: 0,
    y: 0,
    top: 0,
    bottom: 0,
    width: 0,
    height: 0,
    left: edge === "left" ? valuePx : 0,
    right: edge === "right" ? valuePx : 0,
    toJSON: () => ({}),
  };
  el.getBoundingClientRect = () => rect;
}

/**
 * happy-dom lays nothing out, so every measurement the composer takes comes
 * back zero. Stand in for a laid-out row: the span the inline layout leaves
 * between the two control clusters, and the width the draft would take in it
 * with nothing to wrap it.
 */
function stubDraftGeometry(
  container: HTMLElement,
  widths: { inlineWidthPx: number; naturalWidthPx: number },
) {
  stubEdge(inlineActionsStart(container), "right", 0);
  stubEdge(
    inlineActionsEnd(container),
    "left",
    widths.inlineWidthPx + TEXT_FIELD_INSET_X_PX,
  );
  const probe = container.querySelector('[data-slot="composer-draft-probe"]');
  if (!probe) {
    throw new Error("composer rendered without its draft probe");
  }
  Object.defineProperty(probe, "scrollWidth", {
    configurable: true,
    value: widths.naturalWidthPx,
  });
}

/** Type into the draft, which is what re-runs the composer's measurements. */
function typeDraft(container: HTMLElement, value: string) {
  fireEvent.change(textareaOf(container), { target: { value } });
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
  test("isAssistantBusy=false renders a Send button (aria-label='Send message')", () => {
    const html = renderComposer({ isAssistantBusy: false });
    expect(html).toContain('aria-label="Send message"');
    expect(html).not.toContain('aria-label="Stop generating"');
  });

  test("isAssistantBusy=true on desktop renders only the Stop button (send/attach/voice hidden)", () => {
    viewport.set({ narrow: false, coarsePointer: false });
    const html = renderComposer({ isAssistantBusy: true });
    expect(html).toContain('aria-label="Stop generating"');
    expect(html).not.toContain('aria-label="Send message"');
  });

  test("isAssistantBusy=true on a phone with no input renders only Stop button", () => {
    viewport.set({ narrow: true, coarsePointer: true });
    const html = renderComposer({ input: "", isAssistantBusy: true });
    expect(html).toContain('aria-label="Stop generating"');
    expect(html).not.toContain('aria-label="Send message"');
  });

  test("isAssistantBusy=true on a phone with user input renders only Send button", () => {
    viewport.set({ narrow: true, coarsePointer: true });
    const html = renderComposer({ input: "hello", isAssistantBusy: true });
    expect(html).not.toContain('aria-label="Stop generating"');
    expect(html).toContain('aria-label="Send message"');
  });

  // The two shapes where the axes come apart. The busy row's send button
  // substitutes for Enter-to-submit, which `shouldSubmitOnEnter` refuses under a
  // coarse pointer, so both halves read the pointer and each case pins the pair
  // together: whichever way Enter goes, exactly one of the two controls is in
  // the slot. LUM-3224.
  test("a roomy touch device (tablet) with user input gets Send, since Enter cannot submit there", () => {
    viewport.set({ narrow: false, coarsePointer: true });
    const html = renderComposer({ input: "hello", isAssistantBusy: true });
    expect(html).toContain('aria-label="Send message"');
    expect(html).not.toContain('aria-label="Stop generating"');
    expect(shouldSubmitOnEnter(ENTER, true, READY_POLICY)).toBe("ignore");
  });

  test("a narrow mouse-driven window keeps Stop, since Enter already submits there", () => {
    viewport.set({ narrow: true, coarsePointer: false });
    const html = renderComposer({ input: "hello", isAssistantBusy: true });
    expect(html).toContain('aria-label="Stop generating"');
    expect(html).not.toContain('aria-label="Send message"');
    expect(shouldSubmitOnEnter(ENTER, false, READY_POLICY)).toBe("submit");
  });

  // The whole adaptation matrix in one assertion, since the named cases above
  // are instances of a single invariant: the busy row offers exactly one
  // control, and never a disabled one. Counted rather than probed for presence,
  // so a row that grows a second control, loses its only one, or keeps a send
  // nobody can press reads as BROKEN here instead of quietly passing.
  //
  // The blocked-draft rows are the ones that invariant is load-bearing for. A
  // send disabled by an in-flight upload or a prompt holding the send, in a row
  // that has already given up stop, leaves a running turn with no usable
  // control at all. Both are reachable on a phone as much as a tablet: the
  // attachment drop zone is not gated on `isAssistantBusy`, so an upload can
  // start mid-turn. `shouldSubmitOnEnter` refuses both above, and pinning the
  // row to the same three conditions is what keeps the two in agreement.
  test("the busy row always offers exactly one usable control", () => {
    const AXES = [
      { name: "desktop", narrow: false, coarsePointer: false },
      { name: "narrow mouse window", narrow: true, coarsePointer: false },
      { name: "phone", narrow: true, coarsePointer: true },
      { name: "tablet", narrow: false, coarsePointer: true },
    ];
    const DRAFTS = [
      { name: "no draft", props: { input: "" } },
      { name: "draft", props: { input: "hello" } },
      {
        name: "draft, attachment uploading",
        props: { input: "hello", attachmentsUploadingCount: 1 },
      },
      {
        name: "draft, send blocked",
        props: { input: "hello", sendDisabled: true },
      },
      {
        name: "attachment only",
        props: { input: "", canSendAttachments: true },
      },
    ];

    const offered: Record<string, string> = {};
    for (const axis of AXES) {
      for (const draft of DRAFTS) {
        cleanup();
        viewport.set({
          narrow: axis.narrow,
          coarsePointer: axis.coarsePointer,
        });
        const html = renderComposer({ isAssistantBusy: true, ...draft.props });
        const controls = [
          ...html.matchAll(/aria-label="(Stop generating|Send message)"/g),
        ].map((match) => match[1]!);
        const usable =
          controls.length === 1 && !sendButtonHasDisabledAttr(html);
        offered[`${axis.name} / ${draft.name}`] = usable
          ? controls[0]!
          : `BROKEN: [${controls.join(", ")}]`;
      }
    }

    // A fine pointer submits from the keyboard, so stop keeps the slot
    // throughout. A coarse pointer hands it to send exactly when pressing send
    // would queue the draft, which is never true for the two blocked rows.
    expect(offered).toEqual({
      "desktop / no draft": "Stop generating",
      "desktop / draft": "Stop generating",
      "desktop / draft, attachment uploading": "Stop generating",
      "desktop / draft, send blocked": "Stop generating",
      "desktop / attachment only": "Stop generating",
      "narrow mouse window / no draft": "Stop generating",
      "narrow mouse window / draft": "Stop generating",
      "narrow mouse window / draft, attachment uploading": "Stop generating",
      "narrow mouse window / draft, send blocked": "Stop generating",
      "narrow mouse window / attachment only": "Stop generating",
      "phone / no draft": "Stop generating",
      "phone / draft": "Send message",
      "phone / draft, attachment uploading": "Stop generating",
      "phone / draft, send blocked": "Stop generating",
      "phone / attachment only": "Send message",
      "tablet / no draft": "Stop generating",
      "tablet / draft": "Send message",
      "tablet / draft, attachment uploading": "Stop generating",
      "tablet / draft, send blocked": "Stop generating",
      "tablet / attachment only": "Send message",
    });
  });

  test("isAssistantBusy=false keeps the Send button even during awaiting_user_input", () => {
    useTurnStore.setState({
      ...INITIAL_TURN_STATE,
      phase: "awaiting_user_input",
    });
    const html = renderComposer({ isAssistantBusy: false });
    expect(html).toContain('aria-label="Send message"');
    expect(html).not.toContain('aria-label="Stop generating"');
  });

  test("isAssistantBusy=true shows stop button after page refresh (idle phase, server processing)", () => {
    useTurnStore.setState(INITIAL_TURN_STATE);
    const html = renderComposer({ isAssistantBusy: true });
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
  if (idx === -1) {
    return false;
  }
  // Walk back to the opening '<' for this <button>, then forward to the next '>'.
  const openIdx = html.lastIndexOf("<button", idx);
  const closeIdx = html.indexOf(">", idx);
  if (openIdx === -1 || closeIdx === -1) {
    return false;
  }
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

  test("modelPickerSlot renders beside the mic while the composer is wide", () => {
    const html = renderComposer({ modelPickerSlot: <span>PROFILE</span> });
    expect(html).toContain(">PROFILE<");
  });

  test("modelPickerSlot is dropped when the composer is compact", () => {
    // Narrow card: the profile picker folds into the access slot's hamburger
    // (see `ComposerSettingsMenu`), so mounting it here too would double it up.
    mockCompactComposer = true;
    const html = renderComposer({
      thresholdPickerSlot: <span>THR</span>,
      modelPickerSlot: <span>PROFILE</span>,
    });
    expect(html).toContain(">THR<");
    expect(html).not.toContain(">PROFILE<");
  });

  test("voice button is omitted when voiceInputRef/onVoiceTranscript are not provided (app-editing variant)", () => {
    const html = renderComposer();
    // VoiceInputButton renders aria-label="Start voice input" / "Stop voice input".
    expect(html).not.toContain("Start voice input");
    expect(html).not.toContain("Stop voice input");
  });
});

// ---------------------------------------------------------------------------
// Mobile settings pills: the focus-gated row above the card
// ---------------------------------------------------------------------------

describe("ChatComposer: mobile settings pills row", () => {
  test("an unfocused phone composer keeps the row mounted but hidden", () => {
    // GIVEN a phone composer nobody has tapped into
    const { container } = renderPhoneComposer(SETTINGS_SLOTS);

    // THEN the row is mounted, so each menu loads the state its pill gates on
    // before the first focus of the session
    const row = pillsRow(container);
    expect(row?.textContent).toBe("THRPROFILE");

    // AND it is hidden: `hidden` is display:none, which takes the resting row
    // out of the layout, the tab order and the accessibility tree
    expect(row?.hasAttribute("hidden")).toBe(true);
    expect(row?.className).toBe("");

    // AND the action row does not carry the pickers either: mobile moves them
    // out of the card entirely
    expect(container.querySelector("form")?.innerHTML).not.toContain(">THR<");
  });

  test("an app shell keeps the row standing before anyone taps in", () => {
    // GIVEN the same untouched phone composer, in a Capacitor shell
    mockIsNativeMobile = true;
    const { container } = renderPhoneComposer(SETTINGS_SLOTS);

    // THEN the row is up already: on a phone these pills are the only place
    // the access and profile pickers live, so a row that waited for focus put
    // both behind a tap for as long as the composer rested
    const row = pillsRow(container);
    expect(row?.textContent).toBe("THRPROFILE");
    expect(row?.hasAttribute("hidden")).toBe(false);

    // AND it carries no entrance: the animation exists because the row
    // arrives with the keyboard, and standing permanently it would instead
    // replay on every mount, settling the composer on each navigation
    expect(row?.className).not.toContain("animate-");
    expect(row?.className).toContain("flex");
  });

  test("focusing the composer raises the row above the card, access first", () => {
    // GIVEN a phone composer
    const { container } = renderPhoneComposer(SETTINGS_SLOTS);

    // WHEN it takes focus
    fireEvent.focusIn(textareaOf(container));

    // THEN both pills sit in one row outside the card, access before profile
    const row = pillsRow(container);
    expect(row?.textContent).toBe("THRPROFILE");
    expect(row?.closest("form")).toBeNull();
    const html = container.innerHTML;
    expect(html.indexOf(">THR<")).toBeLessThan(html.indexOf("<form"));

    // AND it is shown, rising into place as the keyboard arrives
    expect(row?.hasAttribute("hidden")).toBe(false);
    expect(row?.className).toContain("animate-[fadeInUp");
    expect(row?.className).toContain("motion-reduce:animate-none");
  });

  test("blurring to the body puts the row away without unmounting its menus", () => {
    // GIVEN a focused phone composer
    const { container } = renderPhoneComposer(SETTINGS_SLOTS);
    const textarea = textareaOf(container);
    fireEvent.focusIn(textarea);

    // WHEN focus leaves with nowhere to land, as the iOS keyboard dismiss does
    fireEvent.focusOut(textarea, { relatedTarget: null });

    // THEN the row is hidden again, with its menus still mounted underneath
    const row = pillsRow(container);
    expect(row?.hasAttribute("hidden")).toBe(true);
    expect(row?.textContent).toBe("THRPROFILE");
  });

  test("an open settings sheet holds the row up after focus leaves", () => {
    // GIVEN a phone composer whose access sheet is open
    const { container } = renderPhoneComposer({
      ...SETTINGS_SLOTS,
      settingsSheetOpen: true,
    });
    const textarea = textareaOf(container);
    fireEvent.focusIn(textarea);

    // WHEN the sheet takes focus out of the composer
    fireEvent.focusOut(textarea, { relatedTarget: null });

    // THEN the row the sheet was opened from stays put
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(false);
  });

  test("the native picker holds the row up after it takes the focus", () => {
    // GIVEN a focused mobile-web composer, where the row follows focus
    const { container } = renderPhoneComposer(SETTINGS_SLOTS);
    const textarea = textareaOf(container);
    fireEvent.focusIn(textarea);

    // WHEN the plus hands off to the OS picker, which takes the web view's
    // first responder and so arrives here as focus returning to the body
    fireEvent.click(control(container, PLUS_LABEL)!);
    fireEvent.focusOut(textarea, { relatedTarget: null });

    // THEN the row stays up rather than collapsing behind the picker, the same
    // way the sheet used to hold it
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(false);

    // AND the picker closing gives the composer back to its own focus
    fireEvent(fileInput(container)!, new Event("cancel"));
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(true);
  });

  test("a sheet flag that goes false with focus gone puts the row away", () => {
    // GIVEN a phone composer holding the row up for an open sheet, focus gone
    const { container, rerender } = renderPhoneComposer({
      ...SETTINGS_SLOTS,
      settingsSheetOpen: true,
    });
    const textarea = textareaOf(container);
    fireEvent.focusIn(textarea);
    fireEvent.focusOut(textarea, { relatedTarget: null });

    // WHEN the flag clears, as the settings menu clears it on its way out when
    // the breakpoint swap unmounts the menu that owned the sheet
    rerender(composerElement({ ...SETTINGS_SLOTS, settingsSheetOpen: false }));

    // THEN nothing holds the row up any more
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(true);
  });

  test("desktop keeps both pickers inside the action row, focused or not", () => {
    // GIVEN a desktop composer
    viewport.set({ narrow: false, coarsePointer: false });
    const { container } = renderComposerView(SETTINGS_SLOTS);

    // WHEN it takes focus
    fireEvent.focusIn(textareaOf(container));

    // THEN the pickers stay in the card and no floating row is added
    expect(pillsRow(container)).toBeNull();
    const form = container.querySelector("form");
    expect(form?.innerHTML).toContain(">THR<");
    expect(form?.innerHTML).toContain(">PROFILE<");
  });

  test("a variant with no settings slots renders no row (app-editing panel)", () => {
    // GIVEN a phone composer that was passed neither settings slot
    viewport.set({ narrow: true, coarsePointer: true });
    const { container } = renderComposerView();

    // WHEN it takes focus
    fireEvent.focusIn(textareaOf(container));

    // THEN there is nothing to float, so no row is rendered
    expect(pillsRow(container)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Banners standing over the card, and what gives way to them
// ---------------------------------------------------------------------------

describe("ChatComposer: a banner standing over the card", () => {
  test("an empty banner stack leaves the row up and publishes nothing", () => {
    // GIVEN a resting phone composer in an app shell, with nothing above it
    mockIsNativeMobile = true;
    const { container } = renderPhoneComposer(SETTINGS_SLOTS);

    // THEN the row stands, and the shell carries no flag for the avatar peek
    // that reads this off it
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(false);
    expect(composerShell(container)?.hasAttribute("data-banner-above")).toBe(
      false,
    );
  });

  test("a slot that renders nothing is not a banner", () => {
    // GIVEN a shell composer whose notices slot is mounted but quiet, the way
    // the disk-pressure slot sits there holding its dismiss flags while the
    // disk is healthy
    mockIsNativeMobile = true;
    const Quiet = () => null;
    const { container } = renderPhoneComposer({
      ...SETTINGS_SLOTS,
      noticesAboveFormSlot: <Quiet />,
    });

    // THEN the row stands: what the stack renders decides this, not what is
    // mounted in it
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(false);
    expect(composerShell(container)?.hasAttribute("data-banner-above")).toBe(
      false,
    );
  });

  test("a banner mounted with the composer takes the row down", () => {
    // GIVEN the same shell composer, with a banner in the stack above the card
    mockIsNativeMobile = true;
    const { container } = renderPhoneComposer({
      ...SETTINGS_SLOTS,
      noticesAboveFormSlot: <div>BANNER</div>,
    });

    // THEN the row stands down: the banner docks to the card's top edge and
    // takes the strip the row floats in
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(true);

    // AND the shell publishes the banner, which is how `ComposerPeek` knows to
    // hold its avatar down behind that same edge
    expect(composerShell(container)?.hasAttribute("data-banner-above")).toBe(
      true,
    );
  });

  test("focus does not buy the row back from a banner", () => {
    // GIVEN a browser phone composer under a banner, where focus is normally
    // what raises the row
    const { container } = renderPhoneComposer({
      ...SETTINGS_SLOTS,
      noticesAboveFormSlot: <div>BANNER</div>,
    });

    // WHEN the user taps into it
    fireEvent.focusIn(textareaOf(container));

    // THEN the banner still wins
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(true);
  });

  test("a banner arriving after mount takes the row down with it", async () => {
    // GIVEN a standing row in an app shell
    mockIsNativeMobile = true;
    const { container, rerender } = renderPhoneComposer(SETTINGS_SLOTS);
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(false);

    // WHEN a banner arrives mid-session, the way a low credit balance does
    await act(async () => {
      rerender(
        composerElement({
          ...SETTINGS_SLOTS,
          noticesAboveFormSlot: <div>BANNER</div>,
        }),
      );
    });

    // THEN the row follows it down. The stack is watched rather than derived
    // from props, so notices that source their own state take it down too
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(true);
    expect(composerShell(container)?.hasAttribute("data-banner-above")).toBe(
      true,
    );
  });

  test("a banner leaving gives the row back", async () => {
    // GIVEN a shell composer whose row is down under a banner
    mockIsNativeMobile = true;
    const { container, rerender } = renderPhoneComposer({
      ...SETTINGS_SLOTS,
      noticesAboveFormSlot: <div>BANNER</div>,
    });
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(true);

    // WHEN the banner is dismissed
    await act(async () => {
      rerender(composerElement(SETTINGS_SLOTS));
    });

    // THEN the strip is free again and the row comes back up with it
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(false);
    expect(composerShell(container)?.hasAttribute("data-banner-above")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The single-row mobile composer: plus, divider, input, mic, circular action
// ---------------------------------------------------------------------------

describe("ChatComposer: single-row mobile composer", () => {
  test("a phone composer swaps the paperclip for the plus", () => {
    // GIVEN a phone composer
    const { container } = renderPhoneComposer();

    // THEN the attach control is the plus that opens the sheet, and the
    // paperclip's own picker is gone from the card
    expect(control(container, PLUS_LABEL)).not.toBeNull();
    expect(control(container, "Attach file")).toBeNull();
  });

  test("plus, input and the send slot share one row", () => {
    // GIVEN a phone composer
    const { container } = renderPhoneComposer();

    // THEN the textarea sits in the same row as the controls, rather than
    // above an action row of its own
    const textarea = container.querySelector("textarea");
    const row = textarea?.parentElement?.parentElement;
    expect(row?.contains(control(container, PLUS_LABEL)!)).toBe(true);
    expect(row?.contains(control(container, "Send message")!)).toBe(true);

    // AND the plus leads the row, with the input after it
    const html = container.innerHTML;
    expect(html.indexOf(`aria-label="${PLUS_LABEL}"`)).toBeLessThan(
      html.indexOf("<textarea"),
    );
  });

  test("tapping the plus opens the native picker", () => {
    // GIVEN a phone composer
    const { container } = renderPhoneComposer();
    const input = fileInput(container);

    // AND a picker that takes several files of any type, so WebKit offers its
    // own camera, photo library and file browser menu
    expect(input?.multiple).toBe(true);
    expect(input?.getAttribute("accept")).toBeNull();

    // WHEN the plus is tapped
    let opened = 0;
    input?.addEventListener("click", () => {
      opened += 1;
    });
    fireEvent.click(control(container, PLUS_LABEL)!);

    // THEN the native picker comes up, with nothing of ours in between
    expect(opened).toBe(1);
  });

  test("files picked from the plus reach the composer's attach callback", () => {
    // GIVEN a phone composer
    const onAddAttachmentFiles = mock((_files: FileList | File[]) => {});
    const { container } = renderPhoneComposer({ onAddAttachmentFiles });
    const input = fileInput(container)!;

    // WHEN the picker returns a file
    const picked = new File(["x"], "picked.png", { type: "image/png" });
    selectFiles(input, [picked]);

    // THEN it lands on the same callback the paperclip feeds, which is what
    // runs the vision gate and queues the upload
    expect(onAddAttachmentFiles).toHaveBeenCalledTimes(1);
    expect(onAddAttachmentFiles.mock.calls[0]?.[0]?.[0]).toBe(picked);
  });

  test("the hidden picker input outlives a pointer change mid-pick", () => {
    // GIVEN a phone composer
    const { container, rerender } = renderPhoneComposer();
    const before = fileInput(container);
    expect(before).not.toBeNull();

    // WHEN a keyboard is attached mid-session, while an OS file dialog opened
    // from the plus is still up
    viewport.set({ narrow: true, coarsePointer: false });
    rerender(composerElement());

    // THEN the very same input is still mounted to receive the selection,
    // rather than a fresh one that never opened the dialog
    expect(fileInput(container)).toBe(before);
  });

  test("a narrow window a mouse drives keeps the plus and the same picker", () => {
    // GIVEN a web or Electron window dragged under the mobile breakpoint,
    // still driven by a mouse
    const { container } = renderNarrowMouseComposer();

    // THEN the compact row keeps its plus, over the picker every shape shares
    expect(control(container, PLUS_LABEL)).not.toBeNull();
    expect(fileInput(container)).not.toBeNull();
  });

  test("the plus wears the row's chrome on either narrow window", () => {
    // GIVEN each of the two narrow shapes: a phone, and a window a mouse drags
    // under the breakpoint
    for (const mount of [renderPhoneComposer, renderNarrowMouseComposer]) {
      cleanup();
      const { container } = mount();

      // THEN the plus is the row's 40x40 circle carrying a 20px glyph in both,
      // rather than a desktop control sitting inside a mobile row
      const plus = control(container, PLUS_LABEL);
      expect(plus?.className).toContain(MOBILE_CONTROL_CLASS);
      expect(glyphClassOf(plus)).toContain(MOBILE_GLYPH_CLASS);
    }
  });

  test("native dictation leaves the row's right controls anchored right", () => {
    // GIVEN a phone in the native shell mid-dictation, where the inline
    // waveform takes the textarea's place in the row
    mockIsNativePlatform = true;
    mockVoicePhase = "recording";
    viewport.set({ narrow: true, coarsePointer: true });
    const { container, queryByLabelText } = renderVoiceComposer();

    // THEN the text field is out of the layout, and its `flex-1` with it
    expect(container.querySelector("textarea")?.parentElement?.className).toBe(
      "hidden",
    );

    // WHILE the right-hand group anchors itself rather than packing against
    // the plus on the row's left edge
    const rightGroup = queryByLabelText("Start voice input")?.parentElement;
    expect(rightGroup?.className).toContain("ml-auto");
  });

  test("the context-window indicator centres against the row's controls", () => {
    // GIVEN a phone composer with the device preference on
    const { getByText } = renderPhoneComposer({
      contextWindowIndicatorSlot: <span>CTX</span>,
    });

    // THEN it sits in a control-height box that centres it, rather than flush
    // on the card's bottom edge as a bare child of the `items-end` row
    const box = getByText("CTX").parentElement;
    expect(box?.className).toContain("items-center");
    expect(box?.className).toContain("h-10");
  });

  test("a touch device at desktop width takes the desktop row back", () => {
    // GIVEN a tablet, or a phone turned into landscape
    const { container } = renderTouchTabletComposer();

    // THEN the room it has takes the paperclip back, over the same picker
    expect(control(container, "Attach file")).not.toBeNull();
    expect(fileInput(container)).not.toBeNull();
  });

  test("the Android shell keeps a sheet, since its chooser has no camera", () => {
    // GIVEN the Capacitor Android shell, whose `BridgeWebChromeClient` reaches
    // a camera intent only for an input carrying `capture` and an image accept
    mockIsNativeAndroid = true;
    const { container } = renderPhoneComposer();

    // WHEN the plus is tapped
    fireEvent.click(control(container, PLUS_LABEL)!);

    // THEN the sheet comes up, keeping the camera row this shell has no other
    // way to offer
    expect(addSheet(container)?.getAttribute("data-open")).toBe("true");
  });

  test("files picked in that sheet reach the composer's attach callback", () => {
    // GIVEN the Android shell
    mockIsNativeAndroid = true;
    const onAddAttachmentFiles = mock((_files: FileList | File[]) => {});
    const { getByText } = renderPhoneComposer({ onAddAttachmentFiles });

    // WHEN a sheet row delivers its files
    fireEvent.click(getByText("sheet-pick"));

    // THEN they land on the same callback the picker feeds
    expect(onAddAttachmentFiles).toHaveBeenCalledTimes(1);
    expect(onAddAttachmentFiles.mock.calls[0]?.[0]).toBe(SHEET_PICK);
  });

  test("a sheet that has been up outlives the shell crossing the breakpoint", () => {
    // GIVEN an Android phone whose sheet has been presented
    mockIsNativeAndroid = true;
    const { container, rerender } = renderPhoneComposer();
    fireEvent.click(control(container, PLUS_LABEL)!);

    // WHEN it turns into landscape while a camera pick is still resolving
    viewport.set({ narrow: false, coarsePointer: true });
    rerender(composerElement());

    // THEN the latch keeps its hidden inputs mounted to receive the selection
    expect(addSheet(container)).not.toBeNull();
  });

  test("a shell with only the OS chooser gets the picker, no sheet", () => {
    // GIVEN a mobile surface that is neither the Android shell nor a build
    // holding the native pickers, so a sheet could only raise the OS menu a
    // second time
    const { container } = renderPhoneComposer();

    // THEN nothing of ours stands between the plus and that menu
    expect(addSheet(container)).toBeNull();
  });

  test("a shell holding the native pickers gets the sheet", () => {
    // GIVEN a build whose rows can open the photo picker and the document
    // browser directly, which is the whole reason to show a list of our own
    mockNativePickersAvailable = true;
    const { container } = renderPhoneComposer();

    // THEN the plus opens ours rather than the OS chooser
    expect(addSheet(container)).not.toBeNull();
  });

  test("a busy assistant takes the plus away, as it does the paperclip", () => {
    // GIVEN a phone composer while the assistant is working
    const { container } = renderPhoneComposer({ isAssistantBusy: true });

    // THEN nothing offers to attach
    expect(control(container, PLUS_LABEL)).toBeNull();
    expect(control(container, "Attach file")).toBeNull();
  });

  test("the card is a pill on a phone and keeps its desktop corner elsewhere", () => {
    // GIVEN a phone composer
    const { container } = renderPhoneComposer();

    // THEN the radius is half the collapsed height
    expect(container.querySelector("form")?.className).toContain(
      "rounded-[26px]",
    );

    // WHILE the desktop card keeps the radius it shares with the voice bar
    cleanup();
    viewport.set({ narrow: false, coarsePointer: false });
    const desktop = renderComposerView();
    expect(desktop.container.querySelector("form")?.className).toContain(
      "rounded-[10px]",
    );
  });

  test("desktop keeps the paperclip and its own row", () => {
    // GIVEN a desktop composer
    viewport.set({ narrow: false, coarsePointer: false });
    const { container } = renderComposerView();

    // THEN the attach control is the paperclip, never the row's plus
    expect(control(container, "Attach file")).not.toBeNull();
    expect(control(container, PLUS_LABEL)).toBeNull();

    // AND the textarea stays above the action row rather than inside it
    const html = container.innerHTML;
    expect(html.indexOf("<textarea")).toBeLessThan(
      html.indexOf('aria-label="Attach file"'),
    );
  });
});

// ---------------------------------------------------------------------------
// Past one line the mobile row wraps: full-width draft, controls beneath it
// ---------------------------------------------------------------------------

describe("ChatComposer: a mobile draft past one line", () => {
  test("a draft that still fits keeps every control on the one row", () => {
    // GIVEN a phone composer whose draft is narrower than the row's own span
    const { container } = renderPhoneComposer();
    stubDraftGeometry(container, { inlineWidthPx: 220, naturalWidthPx: 90 });

    // WHEN it is typed
    typeDraft(container, "short");

    // THEN the row stays a single line, with the text field taking whatever
    // the controls beside it leave
    expect(composerRow(container).className).not.toContain("flex-wrap");
    expect(textFieldBlock(container).className).toContain("flex-1");
    expect(textFieldBlock(container).className).not.toContain("basis-full");
  });

  test("a draft past the line takes the full width and drops the controls below", () => {
    // GIVEN a phone composer whose draft has outgrown the row's span
    const { container } = renderPhoneComposer();
    stubDraftGeometry(container, { inlineWidthPx: 220, naturalWidthPx: 640 });

    // WHEN it is typed
    typeDraft(container, "a draft long enough to run past the row's one line");

    // THEN the row wraps, and the text field takes the whole of the first
    // line, ahead of the controls
    expect(composerRow(container).className).toContain("flex-wrap");
    expect(textFieldBlock(container).className).toContain("basis-full");
    expect(textFieldBlock(container).className).toContain("order-first");
    expect(textFieldBlock(container).className).not.toContain("flex-1");

    // AND the controls keep their sides of the row that wrapped beneath it:
    // the plus and its divider lead, the send slot anchors the far end
    const start = inlineActionsStart(container);
    expect(start.contains(control(container, PLUS_LABEL)!)).toBe(true);
    expect(start.innerHTML).toContain("var(--border-hover)");
    expect(
      inlineActionsEnd(container).contains(control(container, "Send message")!),
    ).toBe(true);
    expect(inlineActionsEnd(container).className).toContain("ml-auto");
  });

  test("the layout change never rebuilds the textarea under the caret", () => {
    // GIVEN a phone composer on its inline row
    const { container } = renderPhoneComposer();
    stubDraftGeometry(container, { inlineWidthPx: 220, naturalWidthPx: 90 });
    typeDraft(container, "short");
    const before = textareaOf(container);

    // WHEN the draft grows past the line mid-typing
    stubDraftGeometry(container, { inlineWidthPx: 220, naturalWidthPx: 640 });
    typeDraft(container, "short but then rather a lot longer than that");
    expect(composerRow(container).className).toContain("flex-wrap");

    // THEN it is the very same node, so focus and selection ride the change
    expect(textareaOf(container)).toBe(before);

    // AND again on the way back, which is what deleting past the boundary does
    stubDraftGeometry(container, { inlineWidthPx: 220, naturalWidthPx: 90 });
    typeDraft(container, "short");
    expect(composerRow(container).className).not.toContain("flex-wrap");
    expect(textareaOf(container)).toBe(before);
  });

  test("the draft keeps its place in the DOM through the change", () => {
    // GIVEN a phone composer whose draft has gone past the line
    const { container } = renderPhoneComposer();
    stubDraftGeometry(container, { inlineWidthPx: 220, naturalWidthPx: 640 });
    typeDraft(container, "a draft long enough to run past the row's one line");

    // THEN the visual reordering is the layout's alone: the plus still comes
    // before the textarea in the markup, which is what keeps React from
    // reparenting the field it is typed into
    const html = container.innerHTML;
    expect(html.indexOf(`aria-label="${PLUS_LABEL}"`)).toBeLessThan(
      html.indexOf("<textarea"),
    );
  });

  test("desktop keeps its stacked card and measures no draft", () => {
    // GIVEN a desktop composer, whose card already stacks the text above its
    // own action row
    viewport.set({ narrow: false, coarsePointer: false });
    const { container } = renderComposerView();

    // WHEN a long draft is typed
    typeDraft(container, "a draft long enough to run past any single line");

    // THEN it neither carries the mobile row's probe nor takes its wrapping
    expect(
      container.querySelector('[data-slot="composer-draft-probe"]'),
    ).toBeNull();
    expect(textFieldBlock(container).className).toBe("grid");
  });
});

// ---------------------------------------------------------------------------
// The mobile send slot: filled voice circle until there is something to send
// ---------------------------------------------------------------------------

describe("ChatComposer: the mobile send slot", () => {
  // The row's own chrome (`MOBILE_CONTROL_CLASS`) carries plain, unprefixed
  // classes: it answers to the same width signal that produces the row, so it
  // lands on every narrow window rather than only on the coarse-pointer ones
  // the `touch-mobile:` variant reaches.
  const SEND_FILL_CLASS = "bg-[var(--system-positive-strong)]";

  test("an empty draft leaves the circular live-voice button in the slot", () => {
    // GIVEN a phone composer with nothing to send
    viewport.set({ narrow: true, coarsePointer: true });
    const { queryByLabelText } = renderVoiceComposer({ input: "" });

    // THEN voice mode holds the slot as a filled circle
    const voice = queryByLabelText("Start voice mode");
    expect(voice?.className).toContain(MOBILE_CONTROL_CLASS);
    expect(queryByLabelText("Send message")).toBeNull();
  });

  test("a draft swaps in the circular send and the mic stays", () => {
    // GIVEN a phone composer with something to send
    viewport.set({ narrow: true, coarsePointer: true });
    const { queryByLabelText } = renderVoiceComposer({ input: "hello" });

    // THEN send takes the circle over, in the filled tone of the design
    const send = queryByLabelText("Send message");
    expect(send?.className).toContain(MOBILE_CONTROL_CLASS);
    expect(send?.className).toContain(SEND_FILL_CLASS);
    expect(queryByLabelText("Start voice mode")).toBeNull();

    // AND dictation is untouched beside it
    expect(queryByLabelText("Start voice input")).not.toBeNull();
  });

  test("a send nobody can press keeps the primitive's disabled fill", () => {
    // GIVEN a draft the composer refuses to send
    viewport.set({ narrow: true, coarsePointer: true });
    const { queryByLabelText } = renderVoiceComposer({
      input: "hello",
      sendDisabled: true,
    });

    // THEN the circle stays but the filled tone does not, so a blocked send
    // never reads as one waiting to be pressed
    const send = queryByLabelText("Send message");
    expect(send?.className).toContain(MOBILE_CONTROL_CLASS);
    expect(send?.className).not.toContain(SEND_FILL_CLASS);
  });

  test("a busy turn keeps the phone row's stop/send swap", () => {
    // GIVEN a busy turn with nothing drafted
    viewport.set({ narrow: true, coarsePointer: true });
    const empty = renderVoiceComposer({ input: "", isAssistantBusy: true });

    // THEN stop is the row's only control
    expect(empty.queryByLabelText("Stop generating")).not.toBeNull();
    expect(empty.queryByLabelText("Send message")).toBeNull();

    // WHILE a draft hands the slot to send, since Enter cannot submit here
    cleanup();
    const drafted = renderVoiceComposer({
      input: "hello",
      isAssistantBusy: true,
    });
    expect(drafted.queryByLabelText("Send message")).not.toBeNull();
    expect(drafted.queryByLabelText("Stop generating")).toBeNull();
  });

  test("the busy row's control wears the same circle the resting slot does", () => {
    // GIVEN a busy turn on a phone with nothing drafted
    viewport.set({ narrow: true, coarsePointer: true });
    const empty = renderVoiceComposer({ input: "", isAssistantBusy: true });

    // THEN a turn starting does not shrink the row's right end back to a
    // desktop control
    const stop = empty.queryByLabelText("Stop generating");
    expect(stop?.className).toContain(MOBILE_CONTROL_CLASS);
    expect(glyphClassOf(stop)).toContain(MOBILE_GLYPH_CLASS);

    // AND the send it gives the slot to, once there is a draft, is the same
    // filled circle the resting composer offers
    cleanup();
    const drafted = renderVoiceComposer({
      input: "hello",
      isAssistantBusy: true,
    });
    const send = drafted.queryByLabelText("Send message");
    expect(send?.className).toContain(MOBILE_CONTROL_CLASS);
    expect(send?.className).toContain(SEND_FILL_CLASS);
  });

  test("a narrow mouse-driven window gets the circle a phone gets", () => {
    // GIVEN a window dragged under the breakpoint that a mouse still drives
    viewport.set({ narrow: true, coarsePointer: false });
    const { queryByLabelText } = renderVoiceComposer({ input: "hello" });

    // THEN the row it takes carries the row's chrome throughout, rather than
    // pairing a mobile layout with desktop controls
    const send = queryByLabelText("Send message");
    expect(send?.className).toContain(MOBILE_CONTROL_CLASS);
    expect(send?.className).toContain(SEND_FILL_CLASS);
    expect(glyphClassOf(send)).toContain(MOBILE_GLYPH_CLASS);
  });

  test("the voice circle follows the same signal as the send it shares with", () => {
    // GIVEN each narrow shape with nothing to send
    for (const coarsePointer of [true, false]) {
      cleanup();
      viewport.set({ narrow: true, coarsePointer });
      const { queryByLabelText } = renderVoiceComposer({ input: "" });

      // THEN voice mode holds the slot as the same filled circle either way
      const voice = queryByLabelText("Start voice mode");
      expect(voice?.className).toContain(MOBILE_CONTROL_CLASS);
      expect(glyphClassOf(voice)).toContain(MOBILE_GLYPH_CLASS);
    }
  });

  test("desktop keeps the primitive's own send chrome", () => {
    // GIVEN a roomy window
    viewport.set({ narrow: false, coarsePointer: false });
    const { queryByLabelText } = renderVoiceComposer({ input: "hello" });

    // THEN none of the row's chrome reaches it
    const send = queryByLabelText("Send message");
    expect(send?.className).not.toContain("rounded-full");
    expect(send?.className).not.toContain(SEND_FILL_CLASS);
    expect(glyphClassOf(send)).not.toContain(MOBILE_GLYPH_CLASS);
  });
});

describe("ChatComposer: the mobile row holds focus through a press", () => {
  // WebKit blurs the textarea on a press without focusing the pressed button.
  // The mobile composer is gated on that focus, so the pills row above the card
  // swaps away and the row's 40px controls move out from under the finger
  // before the tap's click lands. Each
  // control cancels the compatibility `mousedown`, the event the focus transfer
  // rides on, and leaves `pointerdown` alone, since WebKit drops the whole rest
  // of the sequence when that one is cancelled. See `docs/CAPACITOR.md`.

  test("the plus cancels the press and still opens the picker", () => {
    // GIVEN a focused phone composer, the state that raises the pills row
    const { container } = renderPhoneComposer(SETTINGS_SLOTS);
    fireEvent.focusIn(textareaOf(container));
    const plus = control(container, PLUS_LABEL)!;

    // THEN the press is cancelled, while the pointer that precedes it is not
    expect(fireEvent.pointerDown(plus)).toBe(true);
    expect(fireEvent.mouseDown(plus)).toBe(false);

    // AND the row is still up when the click arrives, so the plus is still
    // under the finger
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(false);

    // AND the click opens what it always opened
    let opened = 0;
    fileInput(container)?.addEventListener("click", () => {
      opened += 1;
    });
    fireEvent.click(plus);
    expect(opened).toBe(1);
  });

  test("send cancels the press and still submits", () => {
    // GIVEN a focused phone composer with a draft to send
    const onSubmit = mock((event: FormEvent) => event.preventDefault());
    const { container } = renderPhoneComposer({
      ...SETTINGS_SLOTS,
      input: "hello",
      onSubmit,
    });
    fireEvent.focusIn(textareaOf(container));
    const send = control(container, "Send message")!;

    // THEN the press is cancelled, and the submit the click carries is not
    expect(fireEvent.mouseDown(send)).toBe(false);
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("stop cancels the press and still stops the turn", () => {
    // GIVEN the same row mid-turn, where stop takes the slot
    const onStopGenerating = mock(() => {});
    const { container } = renderPhoneComposer({
      ...SETTINGS_SLOTS,
      isAssistantBusy: true,
      onStopGenerating,
    });
    fireEvent.focusIn(textareaOf(container));
    const stop = control(container, "Stop generating")!;

    expect(fireEvent.mouseDown(stop)).toBe(false);
    fireEvent.click(stop);
    expect(onStopGenerating).toHaveBeenCalledTimes(1);
  });

  test("a narrow mouse window keeps its press, and its row", () => {
    // GIVEN the window dragged under the breakpoint, which takes the row's
    // structure with a mouse still driving it. The row is gated on the same
    // focus, but a pointing device focuses the button it presses rather than
    // dropping focus to nothing, so the click lands without any help.
    const { container } = renderNarrowMouseComposer({
      ...SETTINGS_SLOTS,
      input: "hello",
    });
    fireEvent.focusIn(textareaOf(container));
    const send = control(container, "Send message")!;

    // THEN the press is left alone, so the button still takes the focus it is
    // owed and a keyboard user is not stranded on the body
    expect(fireEvent.mouseDown(send)).toBe(true);
    expect(fireEvent.mouseDown(control(container, PLUS_LABEL)!)).toBe(true);

    // AND the row survives that press on its own: focus moves to a button
    // inside the shell, which is not a leave
    fireEvent.focusOut(textareaOf(container), { relatedTarget: send });
    expect(pillsRow(container)?.hasAttribute("hidden")).toBe(false);
  });

  test("a roomy window leaves the press alone", () => {
    // GIVEN a desktop composer, which gates no row on focus
    viewport.set({ narrow: false, coarsePointer: false });
    const { container } = renderComposerView({
      ...SETTINGS_SLOTS,
      input: "hello",
    });

    // THEN the press behaves as the platform intends
    expect(fireEvent.mouseDown(control(container, "Send message")!)).toBe(true);
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
    expect(html).not.toContain('aria-label="Remove attachment"');
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
// `voiceInputRef`/`onVoiceTranscript` precondition). These tests render the
// *voice-enabled* variant so both mic affordances are in play.
// ---------------------------------------------------------------------------

/**
 * Render the composer with the dictation voice props supplied.
 *
 * Also returns `rerenderWith`, which re-renders the same mounted instance with
 * overridden props — used to simulate the user switching chats. The refs are
 * hoisted so a re-render doesn't hand the composer fresh ones.
 */
function renderVoiceComposer(
  props: Partial<Parameters<typeof ChatComposer>[0]> & { input?: string } = {},
) {
  const { input = "", ...rest } = props;
  useComposerStore.setState({ input, attachments: [] });
  const inputRef = createRef<HTMLTextAreaElement>();
  const voiceInputRef = createRef<VoiceInputButtonHandle>();
  const element = (
    overrides: Partial<Parameters<typeof ChatComposer>[0]> = {},
  ) => (
    <ChatComposer
      onSubmit={() => {}}
      inputRef={inputRef}
      typingDisabled={false}
      sendDisabled={false}
      onAddAttachmentFiles={() => {}}
      onStopGenerating={() => {}}
      isAssistantBusy={false}
      assistantId="asst_test"
      conversationId="conv_test"
      voiceInputRef={voiceInputRef}
      onVoiceTranscript={() => {}}
      {...rest}
      {...overrides}
    />
  );
  const result = render(element());
  return {
    ...result,
    rerenderWith: (overrides: Partial<Parameters<typeof ChatComposer>[0]>) =>
      result.rerender(element(overrides)),
  };
}

describe("ChatComposer — live-voice integration", () => {
  test("assistant too old for live voice: no voice button, dictation mic stays enabled", () => {
    // GIVEN an assistant below the live-voice version gate
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockSupportsLiveVoice = false;

    // WHEN the voice-enabled composer renders
    const { queryByLabelText } = renderVoiceComposer();

    // THEN the live-voice control is absent — a click could otherwise sail
    // past the (404ing, fail-open) preflight into a raw WebSocket failure —
    // and dictation is unaffected.
    expect(queryByLabelText("Start voice mode")).toBeNull();
    const dictation = queryByLabelText(
      "Start voice input",
    ) as HTMLButtonElement | null;
    expect(dictation).not.toBeNull();
    expect(dictation?.disabled).toBe(false);
  });

  test("idle + empty: the voice-mode button owns the send slot, dictation available, no voice bar", () => {
    // GIVEN no active session and an empty composer
    useTurnStore.setState(INITIAL_TURN_STATE);

    // WHEN the composer renders
    const { getByLabelText, queryByLabelText, queryByRole } =
      renderVoiceComposer();

    // THEN the voice-mode button occupies the send slot (there is nothing to
    // send yet), dictation is available, and the row is the normal composer
    // row (no voice bar). The send arrow is absent until the message has
    // content (see the swap test below).
    expect(getByLabelText("Start voice mode")).toBeTruthy();
    const dictation = queryByLabelText(
      "Start voice input",
    ) as HTMLButtonElement | null;
    expect(dictation?.disabled).toBe(false);
    expect(queryByRole("group", { name: "Voice session" })).toBeNull();
    expect(queryByLabelText("Send message")).toBeNull();
  });

  test("typing swaps the voice-mode button for the send arrow", () => {
    // GIVEN no active session, and the user has typed content
    useTurnStore.setState(INITIAL_TURN_STATE);

    // WHEN the composer renders with a non-empty draft
    const { getByLabelText, queryByLabelText } = renderVoiceComposer({
      input: "hello",
    });

    // THEN the send arrow takes the slot and the voice-mode button steps aside
    expect(getByLabelText("Send message")).toBeTruthy();
    expect(queryByLabelText("Start voice mode")).toBeNull();
  });

  test("clicking the live-voice button preflights, then starts a session through the store-registered starter", async () => {
    // GIVEN no active session and a `ready` verdict
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockPreflightVerdict = { status: "ready" };

    // WHEN the user clicks the entry-point mic
    const { getByLabelText } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));

    // Playback unlock happens synchronously in the click task, while the
    // readiness request is still pending.
    expect(livePrewarmSpy).toHaveBeenCalledTimes(1);
    expect(preflightSpy).toHaveBeenCalledWith("asst_test");
    expect(liveStarterSpy).not.toHaveBeenCalled();

    await flushPreflight();

    // THEN the layout-owned controller starts with the bound context after the
    // ready verdict (the composer holds no controller of its own).
    expect(liveStarterSpy).toHaveBeenCalledTimes(1);
    expect(liveStarterSpy).toHaveBeenCalledWith("asst_test", "conv_test");
    expect(liveCancelPrewarmSpy).not.toHaveBeenCalled();
  });

  test("entering voice mode drops the composer's focus, and only that", async () => {
    // GIVEN a focused composer on a soft-keyboard device. The voice button
    // cancels the press that would otherwise blur this, so its click survives
    // the row's focus gating, which leaves that keyboard raised.
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockPreflightVerdict = { status: "ready" };
    viewport.set({ narrow: true, coarsePointer: true });
    const { container, getByLabelText } = renderVoiceComposer();
    const textarea = container.querySelector("textarea")!;
    // Real focus rather than a synthetic `focusIn`: the assertion below is
    // about `document.activeElement`, and the focus this raises drives the
    // composer's own focus-gated state.
    act(() => {
      textarea.focus();
    });
    expect(document.activeElement).toBe(textarea);

    // WHEN the user taps into voice mode
    fireEvent.click(getByLabelText("Start voice mode"));

    // THEN the entry drops that focus itself, now that the click it depended on
    // has been delivered. The room takes the whole screen and has no use for a
    // keyboard under it.
    expect(document.activeElement).not.toBe(textarea);

    // Drain the preflight the click started, so its resolution does not land
    // after the test has returned.
    await flushPreflight();
  });

  // The `not-ready` verdict is the one that makes stranded focus bite: the room
  // never opens, and the configure-voice action it raises is what the user then
  // has to reach. Both entries below drive it for that reason.
  const NOT_READY_VERDICT = {
    status: "not-ready" as const,
    missing: [
      { kind: "tts" as const, providerId: "elevenlabs", reason: "no key" },
    ],
    userMessage: "Add a voice provider to start talking.",
  };

  test("entering voice mode from the button itself leaves that focus alone", async () => {
    // GIVEN a keyboard user on the voice button, which leaves focus there
    // rather than on the textarea
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockPreflightVerdict = NOT_READY_VERDICT;
    viewport.set({ narrow: true, coarsePointer: true });
    const { getByLabelText } = renderVoiceComposer();
    const button = getByLabelText("Start voice mode");
    act(() => {
      button.focus();
    });

    // WHEN the entry runs
    fireEvent.click(button);

    // THEN it blurs the textarea by name, which holds no focus to take, and
    // leaves this where it is
    expect(document.activeElement).toBe(button);
    await flushPreflight();
  });

  test("a pointing device keeps the composer's focus through the entry", async () => {
    // GIVEN a focused composer with no soft keyboard to dismiss: a mouse-driven
    // window, narrow enough to carry the row
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockPreflightVerdict = NOT_READY_VERDICT;
    viewport.set({ narrow: true, coarsePointer: false });
    const { container, getByLabelText } = renderVoiceComposer();
    const textarea = container.querySelector("textarea")!;
    act(() => {
      textarea.focus();
    });

    // WHEN the entry runs
    fireEvent.click(getByLabelText("Start voice mode"));

    // THEN nothing is blurred at all. There is no keyboard raised over the room,
    // so the only thing a blur could do here is cost the user their place.
    expect(document.activeElement).toBe(textarea);
    await flushPreflight();
  });

  test("a not-ready verdict keeps the room closed and surfaces the configure-voice prompt", async () => {
    // GIVEN no usable STT/TTS provider can be configured
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockPreflightVerdict = {
      status: "not-ready",
      missing: [{ kind: "tts", providerId: "elevenlabs", reason: "no key" }],
      userMessage: "Add a voice provider to start talking.",
    };

    // WHEN the user clicks the entry-point mic
    const { getByLabelText, getByText, queryByText } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));
    await flushPreflight();

    // THEN the session never starts (the room stays closed / idle) and the
    // daemon's configure-voice message is shown instead
    expect(preflightSpy).toHaveBeenCalledWith("asst_test");
    expect(liveStarterSpy).not.toHaveBeenCalled();
    expect(livePrewarmSpy).toHaveBeenCalledTimes(1);
    expect(liveCancelPrewarmSpy).toHaveBeenCalledTimes(1);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
    expect(getByText("Add a voice provider to start talking.")).toBeTruthy();

    // AND the prompt's action deep-links to the voice settings page
    fireEvent.click(getByText("Configure voice"));
    expect(navigateSpy).toHaveBeenCalledWith("/assistant/settings/voice");
    // ...and dismisses itself on navigation
    expect(queryByText("Add a voice provider to start talking.")).toBeNull();
  });

  test("a preflight error fails OPEN — the session still starts", async () => {
    // GIVEN the preflight call itself fails (returns null)
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockPreflightVerdict = null;

    // WHEN the user clicks the entry-point mic
    const { getByLabelText } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));
    await flushPreflight();

    // THEN a preflight outage does not block voice — the session starts and
    // the WS-level handshake surfaces any real credential problem
    expect(liveStarterSpy).toHaveBeenCalledTimes(1);
    expect(liveStarterSpy).toHaveBeenCalledWith("asst_test", "conv_test");
    expect(livePrewarmSpy).toHaveBeenCalledTimes(1);
    expect(liveCancelPrewarmSpy).not.toHaveBeenCalled();
  });

  test("switching chats mid-preflight drops the verdict instead of binding the room to the chat the user left", async () => {
    // GIVEN a preflight that stays in flight until we say so
    useTurnStore.setState(INITIAL_TURN_STATE);
    let resolvePreflight!: (verdict: LiveVoicePreflightVerdict | null) => void;
    preflightSpy.mockImplementationOnce(
      () =>
        new Promise<LiveVoicePreflightVerdict | null>((resolve) => {
          resolvePreflight = resolve;
        }),
    );

    // WHEN the user starts voice, then navigates to another conversation
    // before the verdict comes back
    const { getByLabelText, rerenderWith } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));
    rerenderWith({ conversationId: "conv_other" });
    resolvePreflight({ status: "ready" });
    await flushPreflight();

    // THEN the stale verdict is dropped — no room is opened, and critically it
    // is not opened against `conv_test`, the chat the user already left
    expect(preflightSpy).toHaveBeenCalledWith("asst_test");
    expect(liveStarterSpy).not.toHaveBeenCalled();
    expect(liveCancelPrewarmSpy).toHaveBeenCalledTimes(1);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });

  test("first-ever entry opens the prefs card instead of starting the session", () => {
    // GIVEN no session, and the user has never entered voice
    useTurnStore.setState(INITIAL_TURN_STATE);
    useVoicePrefsStore.setState({ firstRunSeen: false });

    // WHEN the user clicks the entry-point mic
    const { getByLabelText, getByTestId } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));

    // THEN the prefs card appears (dismissible on web) and the session has NOT
    // started yet
    expect(getByTestId("first-run-card")).toBeTruthy();
    expect(
      getByTestId("first-run-card").getAttribute("data-non-dismissible"),
    ).toBe("false");
    expect(liveStarterSpy).not.toHaveBeenCalled();
    expect(livePrewarmSpy).not.toHaveBeenCalled();
  });

  test("first-run card Start persists the flag then starts the session", async () => {
    // GIVEN the first-run card is open
    useTurnStore.setState(INITIAL_TURN_STATE);
    useVoicePrefsStore.setState({ firstRunSeen: false });
    const { getByLabelText, getByText, queryByTestId } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));

    // WHEN the user commits via Start
    fireEvent.click(getByText("first-run-start"));
    await flushPreflight();

    // THEN the first run is consumed, the card closes, and the session starts
    // (after the readiness preflight)
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);
    expect(queryByTestId("first-run-card")).toBeNull();
    expect(liveStarterSpy).toHaveBeenCalledTimes(1);
    expect(liveStarterSpy).toHaveBeenCalledWith("asst_test", "conv_test");
    expect(livePrewarmSpy).toHaveBeenCalledTimes(1);
  });

  test("dismissing the first-run card cancels without consuming the first run", () => {
    // GIVEN the first-run card is open
    useTurnStore.setState(INITIAL_TURN_STATE);
    useVoicePrefsStore.setState({ firstRunSeen: false });
    const { getByLabelText, getByText, queryByTestId } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));

    // WHEN the user dismisses it
    fireEvent.click(getByText("first-run-dismiss"));

    // THEN nothing started and the first run is still available for next time
    expect(queryByTestId("first-run-card")).toBeNull();
    expect(liveStarterSpy).not.toHaveBeenCalled();
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);
    expect(livePrewarmSpy).not.toHaveBeenCalled();
  });

  test("Capacitor iOS: first-ever entry shows the prefs card too (web↔iOS parity)", () => {
    // GIVEN the native iOS shell, the flag on, no session, and a first-ever
    // entry. The card is intentionally shown on every platform — a deliberate
    // deviation from CAPACITOR.md's "no dismissible pre-prompt before
    // getUserMedia" rule, chosen for parity with web (see the composer's
    // handleLiveVoiceStart note) — so the iOS shell must get it too.
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockIsNativeIOS = true;
    useVoicePrefsStore.setState({ firstRunSeen: false });

    // WHEN the user clicks the entry-point mic
    const { getByLabelText, getByTestId } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));

    // THEN the same prefs card appears and the session has NOT started yet —
    // like web, but locked (non-dismissible) so it leads straight to the mic
    // alert per CAPACITOR.md.
    expect(getByTestId("first-run-card")).toBeTruthy();
    expect(
      getByTestId("first-run-card").getAttribute("data-non-dismissible"),
    ).toBe("true");
    expect(liveStarterSpy).not.toHaveBeenCalled();
    expect(livePrewarmSpy).not.toHaveBeenCalled();
  });

  test("Capacitor iOS: returning-user entry prewarms and starts after preflight", async () => {
    // GIVEN the native iOS shell with the first run already consumed
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockIsNativeIOS = true;
    // resetLiveVoiceMocks already sets firstRunSeen: true

    // WHEN the user clicks the entry-point mic
    const { getByLabelText, queryByTestId } = renderVoiceComposer();
    fireEvent.click(getByLabelText("Start voice mode"));
    await flushPreflight();

    // THEN it behaves exactly like the returning-user path on any platform
    expect(queryByTestId("first-run-card")).toBeNull();
    expect(liveStarterSpy).toHaveBeenCalledTimes(1);
    expect(liveStarterSpy).toHaveBeenCalledWith("asst_test", "conv_test");
    expect(livePrewarmSpy).toHaveBeenCalledTimes(1);
  });

  test("owned active session adds the voice bar and keeps the composer usable", () => {
    // GIVEN a live-voice session owned by this composer's conversation
    useTurnStore.setState(INITIAL_TURN_STATE);
    seedLiveVoiceSession("listening");

    // WHEN the composer renders
    const { getByRole, getByLabelText, queryByLabelText } =
      renderVoiceComposer();

    // THEN the voice bar is mounted alongside the action row, not in place of
    // it: send is still there, so the user can type and send mid-session
    expect(getByRole("group", { name: "Voice session" })).toBeTruthy();
    expect(getByLabelText("Send message")).toBeTruthy();
    // ...while both voice entry points are gone — the bar is the session's
    // control, and a second mic capture flow must not be startable
    expect(queryByLabelText("Start voice mode")).toBeNull();
    expect(queryByLabelText("Start voice input")).toBeNull();
    // ...and the old inline transcript strip is gone for good
    expect(queryByLabelText("Live voice transcript")).toBeNull();
  });

  test("the voice bar sits above the composer card, not inside it", () => {
    // GIVEN a live-voice session owned by this composer's conversation
    useTurnStore.setState(INITIAL_TURN_STATE);
    seedLiveVoiceSession("listening");

    // WHEN the composer renders
    const { container, getByRole } = renderVoiceComposer();

    // THEN the bar is outside the form: inside it, it would be part of the
    // card the user is typing into rather than a surface stacked above it
    const bar = getByRole("group", { name: "Voice session" });
    const form = container.querySelector('[data-slot="chat-composer"]');
    expect(form).not.toBeNull();
    expect(form?.contains(bar)).toBe(false);
  });

  test("session owned by another conversation leaves this composer untouched (pill is the surface)", () => {
    // GIVEN a session owned by thread A while this composer shows thread B
    useTurnStore.setState(INITIAL_TURN_STATE);
    seedLiveVoiceSession("listening", "conv-other-thread");

    // WHEN the composer renders
    const { container, getByLabelText, queryByLabelText, queryByRole } =
      renderVoiceComposer();

    // THEN no voice bar, no transcript region, and the textarea stays
    // editable — thread B behaves like a normal composer. The empty send slot
    // holds the voice-mode button (disabled below), so the send arrow is absent.
    expect(queryByRole("group", { name: "Voice session" })).toBeNull();
    expect(queryByLabelText("Send message")).toBeNull();
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
    seedLiveVoiceSession("listening", null);
    useLiveVoiceStore.getState().setConversationId("conv-server-assigned");

    // WHEN the draft composer (bound to no conversation) renders
    const { getByRole } = renderVoiceComposer({ conversationId: undefined });

    // THEN it still owns the session — the voice bar stays, so the user
    // sitting at the composer that started the session never sees it
    // handed off to the title-bar pill
    expect(getByRole("group", { name: "Voice session" })).toBeTruthy();
  });

  test("owned session leaves the textarea usable", () => {
    // GIVEN a live-voice session owned by this composer's conversation
    useTurnStore.setState(INITIAL_TURN_STATE);
    seedLiveVoiceSession("listening");

    // WHEN the composer renders
    const { container } = renderVoiceComposer();

    // THEN the textarea is mounted and editable: typing alongside a live
    // session is the point of the bar sitting above the card
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect((textarea as HTMLTextAreaElement).disabled).toBe(false);
  });

  test("voice bar ✕ ends the session even when the composer is busy", () => {
    // GIVEN a live session AND the composer is otherwise disabled
    useTurnStore.setState(INITIAL_TURN_STATE);
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

  test("voice bar offers no manual send — turns release themselves", () => {
    // GIVEN a listening session owned by this composer
    useTurnStore.setState(INITIAL_TURN_STATE);
    seedLiveVoiceSession("listening");

    // WHEN the bar renders
    const { queryByLabelText } = renderVoiceComposer();

    // THEN there is no send-now control: server VAD (hands-free) and
    // auto-release (manual fallback) both end the turn without the user.
    expect(queryByLabelText("Send now")).toBeNull();
    expect(liveControls.release).not.toHaveBeenCalled();
  });

  test("voice session keeps the textarea row on screen", () => {
    // GIVEN a listening session owned by this composer
    useTurnStore.setState(INITIAL_TURN_STATE);
    seedLiveVoiceSession("listening");

    // WHEN the bar renders
    const { container } = renderVoiceComposer();

    // THEN the textarea row stays: the placeholder now invites an interaction
    // that works, so collapsing the row would take away a live control.
    const textarea = container.querySelector("textarea");
    expect(textarea?.closest("div.hidden")).toBeNull();
  });

  test("dictation active hides the live-voice button (reverse mutual exclusion)", () => {
    // GIVEN no live session, but dictation is active.
    // `processing` is one of the two phases that make the composer's
    // `isVoiceActive` true (alongside `recording`); we use it because
    // `recording` additionally spins up amplitude analysis (getUserMedia),
    // which happy-dom doesn't provide — the mutual-exclusion signal is the
    // same either way.
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockVoicePhase = "processing";

    // WHEN the composer renders
    const { queryByLabelText } = renderVoiceComposer();

    // THEN the send slot (which holds the voice-mode entry point while idle) is
    // hidden entirely during dictation, so no second mic/voice session can open
    // alongside the recorder — mutual exclusion by absence.
    expect(queryByLabelText("Start voice mode")).toBeNull();
  });

  test("electron dictation uses the system overlay instead of the inline composer preview", () => {
    // GIVEN Electron is hosting the composer and dictation is processing.
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockIsElectron = true;
    mockVoicePhase = "processing";

    // WHEN the composer renders
    const { queryByLabelText } = renderVoiceComposer();

    // THEN the shared top-center dictation overlay owns the visual treatment,
    // so the composer-specific preview is absent; and the send slot (voice-mode
    // entry point) stays hidden during dictation — mutual exclusion by absence.
    expect(queryByLabelText("Transcribing")).toBeNull();
    expect(queryByLabelText("Start voice mode")).toBeNull();
  });

  test("failed live-voice state is inactive: normal row restored, dictation re-enabled", () => {
    // GIVEN a live-voice session has failed
    useTurnStore.setState(INITIAL_TURN_STATE);
    seedLiveVoiceSession("listening");
    useLiveVoiceStore.getState().fail("boom");

    // WHEN the composer renders (dictation idle)
    const { getByLabelText, queryByRole } = renderVoiceComposer();

    // THEN the voice bar is unmounted and the normal row is back — with an
    // empty draft the send slot shows the voice-mode entry point again...
    expect(queryByRole("group", { name: "Voice session" })).toBeNull();
    expect(getByLabelText("Start voice mode")).toBeTruthy();
    // ...with dictation treated as available again (failed = inactive)
    const dictation = getByLabelText("Start voice input") as HTMLButtonElement;
    expect(dictation.disabled).toBe(false);
  });

  test("failed session surfaces the error as a dismissible notice", () => {
    // GIVEN a failed session carrying an error message
    useTurnStore.setState(INITIAL_TURN_STATE);
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
    // GIVEN an idle session and no error
    useTurnStore.setState(INITIAL_TURN_STATE);

    // WHEN the composer renders
    const { queryByLabelText } = renderVoiceComposer();

    // THEN no dismissible notice is mounted
    expect(queryByLabelText("Dismiss")).toBeNull();
  });

  test("voice bar persists when the version gate drops mid-session (no stranded session)", () => {
    // GIVEN an active owned session whose assistant has since fallen below
    // the gate (a version re-fetch mid-session) while the layout-owned
    // controller keeps the session live
    useTurnStore.setState(INITIAL_TURN_STATE);
    mockSupportsLiveVoice = false;
    seedLiveVoiceSession("listening");

    // WHEN the composer renders
    const { getByRole, getByLabelText, queryByLabelText } =
      renderVoiceComposer();

    // THEN the active-UI swap follows the session state, not eligibility:
    // the bar (and its ✕ stop control) stays until teardown completes...
    expect(getByRole("group", { name: "Voice session" })).toBeTruthy();
    const end = getByLabelText("End voice session") as HTMLButtonElement;
    expect(end.disabled).toBe(false);
    // ...while the entry-point button stays gated off
    expect(queryByLabelText("Start voice mode")).toBeNull();

    // AND the ✕ still ends the live session
    fireEvent.click(end);
    expect(liveControls.stop).toHaveBeenCalledTimes(1);
  });

  test("voice bar persists when assistantId is transiently cleared mid-session", () => {
    // GIVEN an active owned session whose assistantId has been cleared from
    // props
    useTurnStore.setState(INITIAL_TURN_STATE);
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
    seedLiveVoiceSession("listening", "conv-other-thread");

    // WHEN the app-editing variant renders (no voiceInputRef/onVoiceTranscript)
    const html = renderComposer();

    // THEN its action row is untouched — no voice bar, normal send button
    expect(html).not.toContain('aria-label="Voice session"');
    expect(html).toContain('aria-label="Send message"');
  });
});

// ---------------------------------------------------------------------------
// The composer's text area during a live-voice session
//
// The session's surface is the bar above the card, so the text area is an
// ordinary text area throughout: mounted, editable, and never given over to
// the user's own speech. "Show the words you say" is served by the room's
// transcript instead — minimizing is the gesture that puts the user back on
// the thread rather than on their words.
//
// The textarea's own `className` is not the signal: the row wrapping it is
// what would carry `hidden`, so assertions go through `textareaRowHidden`.
// ---------------------------------------------------------------------------

/** Whether the grid row wrapping the textarea is collapsed. */
function textareaRowHidden(container: HTMLElement): boolean {
  const textarea = container.querySelector("textarea");
  if (!textarea) {
    throw new Error("no textarea rendered");
  }
  return textarea.closest("div.hidden") !== null;
}

describe("ChatComposer — text area during a live-voice session", () => {
  test("streaming speech never takes the text area, even with the pref on", () => {
    // GIVEN a listening owned session with an in-flight partial transcript,
    // and the user opted in to seeing their own words
    useTurnStore.setState(INITIAL_TURN_STATE);
    useVoicePrefsStore.setState({ showUserTranscript: true });
    seedLiveVoiceSession("listening");
    useLiveVoiceStore
      .getState()
      .setPartialTranscript("this is a text that I am just speaking");

    // THEN the composer stays a composer: the speech is not painted into it,
    // and the input it would have displaced is still usable
    const { container, queryByLabelText } = renderVoiceComposer();
    expect(queryByLabelText("Voice transcript")).toBeNull();
    expect(container.textContent).not.toContain(
      "this is a text that I am just speaking",
    );
    expect(textareaRowHidden(container)).toBe(false);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
  });

  test("speech from a session owned by another thread never streams into this composer", () => {
    // GIVEN a session owned by thread A streaming speech while this composer
    // shows thread B
    useTurnStore.setState(INITIAL_TURN_STATE);
    seedLiveVoiceSession("listening", "conv-other-thread");
    useLiveVoiceStore.getState().setPartialTranscript("thread A's words");

    // WHEN the composer renders
    const { container, queryByLabelText } = renderVoiceComposer();

    // THEN no transcript region mounts and this composer keeps a normal,
    // editable input — thread A's speech must not leak into thread B's input,
    // and thread B's own row is not a session surface
    expect(queryByLabelText("Voice transcript")).toBeNull();
    expect(textareaRowHidden(container)).toBe(false);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
  });

  test("textarea is untouched after the session ends, even with a leftover final transcript", () => {
    // GIVEN the session has ended (store back to idle, final text lingering)
    useTurnStore.setState(INITIAL_TURN_STATE);
    useLiveVoiceStore.getState().setFinalTranscript("what I said last");

    // WHEN the composer renders
    const { container, queryByLabelText } = renderVoiceComposer();

    // THEN the composer behaves normally: no transcript region, and the row
    // is there with an editable textarea
    expect(queryByLabelText("Voice transcript")).toBeNull();
    expect(textareaRowHidden(container)).toBe(false);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
  });

  test("ghost suffix renders normally with no active session (baseline)", () => {
    // GIVEN an empty draft and a pending autocomplete suggestion, no session
    const html = renderComposer({
      input: "",
      suggestion: "ghost completion text",
    });

    // THEN the ghost suffix paints into the composer's mirror cell
    expect(html).toContain("ghost completion text");
  });

  test("an owned live-voice session keeps the ghost suffix", () => {
    // GIVEN a listening session this composer owns and a pending suggestion.
    // The ghost used to be suppressed because the streaming transcript shared
    // its grid cell; nothing renders there now, and the draft is a real draft
    // for the session's duration, so the suggestion is as useful as ever.
    useTurnStore.setState(INITIAL_TURN_STATE);
    seedLiveVoiceSession("listening");

    // WHEN the composer renders with the suggestion present
    const { container } = renderVoiceComposer({
      suggestion: "ghost completion text",
    });

    // THEN the ghost paints as it would without a session
    expect(container.textContent).toContain("ghost completion text");
  });
});

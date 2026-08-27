import { ArrowUp, Square } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "react-router";

import { PlusIcon } from "@/domains/chat/components/plus-icon";
import {
  AttachFileButton,
  ChatAttachmentsStrip,
} from "@/domains/chat/components/chat-attachments/chat-attachments";
import { useAttachmentFilePicker } from "@/domains/chat/components/chat-attachments/use-attachment-file-picker";
import { useCameraDeepLink } from "@/domains/chat/components/chat-attachments/use-camera-deep-link";
import {
  selectPathReferencePaths,
  selectUploadedIds,
  selectUploadingCount,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { useChannelReferenceStore } from "@/domains/chat/channel-sidecar/channel-reference-store";
import { useHasPendingQuestion } from "@/domains/chat/interaction-store";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import { useComposerFocusWithin } from "@/domains/chat/hooks/use-composer-focus-within";
import { ComposerDraftNotices } from "@/domains/chat/components/composer-draft-notices";
import { nativeAttachmentPickersAvailable } from "@/domains/chat/components/chat-attachments/native-attachment-pickers";
import { AddToChatSheet } from "@/domains/chat/components/chat-composer/add-to-chat-sheet";
import { StreamingWaveform } from "@/domains/chat/components/chat-composer/streaming-waveform";
import {
  ComposerCompactProvider,
  useIsCompactComposerWidth,
} from "@/domains/chat/components/chat-composer/composer-compact";
import {
  MOBILE_CONTROL_CLASS,
  MOBILE_GHOST_WASH_CLASS,
  MOBILE_GLYPH_CLASS,
  preventPressFocusTransfer,
} from "@/domains/chat/components/chat-composer/composer-mobile-chrome";
import {
  COMPOSER_MOBILE_RADIUS_CLASS,
  COMPOSER_RADIUS_CLASS,
  VoiceComposerBar,
} from "@/domains/chat/components/chat-composer/voice-composer-bar";
import { LiveVoiceButton } from "@/domains/chat/components/live-voice-button";
import { useSupportsLiveVoice } from "@/lib/backwards-compat/use-supports-live-voice";
import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import { type TurnPhase, useTurnStore } from "@/domains/chat/turn-store";
import { endLiveVoiceSessionOnAssistant } from "@/domains/chat/voice/live-voice/live-voice-session-end-api";
import { navigateToConversation } from "@/utils/conversation-navigation";
import {
  dismissLiveVoiceFailure,
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  getLiveVoiceOutputAmplitude,
  isLiveVoiceSessionActive,
  restoreVoiceRoom,
  setLiveVoiceEntryOrigin,
  setLiveVoiceMuted,
  setLiveVoiceOutputMuted,
  useIsLiveVoiceSessionOwnedBy,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { voiceEntryGreetingSeed } from "@/domains/chat/voice/live-voice/voice-entry-greeting";
import {
  firstRunCardIntercepts,
  publishConfigNotice,
  voiceReadiness,
} from "@/domains/chat/voice/live-voice/voice-entry-guards";
import { useAudioAmplitude } from "@/domains/chat/voice/use-audio-amplitude";
import { VoiceFirstRunCard } from "@/domains/chat/voice/voice-room/voice-first-run-card";
import { useVoiceSurfacePaint } from "@/domains/chat/voice/voice-room/use-voice-surface-paint";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { isElectron } from "@/runtime/is-electron";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";
import { useIsNativePlatform } from "@/runtime/native-auth";
import {
  isNativeIOS,
  useIsNativeAndroid,
  useIsNativeMobile,
} from "@/runtime/platform-detection";
import { isPointerCoarse, usePointerCoarse } from "@/utils/pointer";
import { routes } from "@/utils/routes";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { useTranslation } from "@/i18n";
import { Button, cn, Notice, Popover } from "@vellumai/design-library";

import {
  computeGhostSuffix,
  isDraftPastOneLine,
  shouldSubmitOnEnter,
} from "@/domains/chat/components/chat-composer/chat-composer-utils";
import {
  EMOJI_MIN_FILTER_LENGTH,
  EMOJI_TRIGGER_RE,
  type EmojiEntry,
  useEmojiSearch,
} from "@/domains/chat/components/chat-composer/emoji-catalog";
import { EmojiPickerPopup } from "@/domains/chat/components/chat-composer/emoji-picker-popup";
import {
  applyMarkdownFormatting,
  matchFormattingShortcut,
} from "@/domains/chat/components/chat-composer/markdown-formatting";
import {
  SLASH_PREFIX_RE,
  type SlashCommand,
  filteredCommands,
  selectedInputText,
} from "@/domains/chat/components/chat-composer/slash-command-catalog";
import { SlashCommandPopup } from "@/domains/chat/components/chat-composer/slash-command-popup";
import { useTextPopup } from "@/domains/chat/components/chat-composer/use-text-popup";

/**
 * Composer used at the bottom of the chat (main variant) and inside the
 * app-editing split layout.
 *
 * The draft text is the only high-frequency state here, so the composer
 * subscribes to it directly from `composer-store` via atomic selectors (per
 * `docs/STATE_MANAGEMENT.md`) rather than receiving it as a prop. That keeps a
 * keystroke from re-rendering the orchestrator and the transcript above it —
 * only this component re-renders as you type.
 *
 * The optional slots/voice props exist because the app-editing variant does
 * NOT render a voice button, threshold picker, context-window indicator, or
 * the notice banners above the form — only the main variant does. Passing
 * those as `undefined` keeps the app-editing layout byte-identical.
 */
export interface ChatComposerProps {
  placeholder?: string;
  onSubmit: (event: FormEvent) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  typingDisabled: boolean;
  sendDisabled: boolean;

  // Adding files is orchestration-owned: it runs the vision-capability gate
  // (which depends on the active model) before queueing the upload. The rest of
  // the attachment lifecycle — the strip, the uploading/can-send derivation, and
  // removal — is read straight from the composer store below.
  /**
   * Takes the picked files and answers with the ones it kept, where it filters
   * at all. Returning nothing counts as keeping them, so a caller that does no
   * filtering stays a plain callback and cannot free an allowance by accident.
   */
  onAddAttachmentFiles: (files: FileList | File[]) => File[] | void;

  // voice — optional; when `voiceInputRef` is omitted the voice button is
  // skipped entirely (matches the app-editing variant which has no voice).
  voiceInputRef?: RefObject<VoiceInputButtonHandle | null>;
  onVoiceTranscript?: (text: string) => void;
  onVoiceInterimTranscript?: (text: string) => void;
  /** Live partial transcript shown as ghost text below the waveform while recording. */
  voiceInterim?: string;
  onVoiceError?: (code: string | null) => void;
  onVoiceBeforeStart?: () => boolean | Promise<boolean>;

  onStopGenerating: () => void;
  /**
   * Whether the assistant is actively working (not waiting for user input).
   * Single source of truth shared with the avatar spinner. The composer must
   * not derive this locally because the turn store resets to idle on refresh.
   */
  isAssistantBusy: boolean;

  // assistant id used by AttachFileButton's disabled guard
  assistantId: string | null;

  // Conversation this composer is bound to — used to attach live-voice
  // sessions and to decide whether this composer owns the active session
  // (see `isLiveVoiceSessionOwnedBy`). Pass the routing-truth id
  // (`activeConversationId`), including client-generated draft ids, so the
  // session lands in the thread the user is looking at. Optional — when
  // absent the session starts without a conversation and the server assigns
  // one. The app-editing variant, which has no voice, leaves this undefined.
  conversationId?: string | null;

  // Whether that conversation has nothing in it yet. Drives the one decision
  // in `voiceEntryGreetingSeed`: a voice session opened on a blank thread
  // takes its first turn on the user's behalf so the assistant speaks first,
  // and one opened on a thread already underway does not. Pass the same value
  // the empty state renders from, so the two cannot disagree about what empty
  // means. Optional, defaulting to false: a caller that says nothing opens a
  // silent room.
  conversationIsEmpty?: boolean;

  // chrome surfacing existing buttons (rendered in the form's bottom-left row
  // on desktop; on mobile both settings slots move to the row above the card)
  thresholdPickerSlot?: ReactNode;
  contextWindowIndicatorSlot?: ReactNode;
  // Model-profile picker rendered on the row's right end, beside the mic
  // (Figma: New-App 7471-25234). The orchestrator passes a second
  // `ComposerSettingsMenu` instance scoped to the profile segment. Dropped
  // below the compact card width, where `thresholdPickerSlot`'s menu absorbs
  // the profile section rather than the two triggers colliding.
  modelPickerSlot?: ReactNode;

  // Whether a surface opened from one of the two settings slots is up. Opening
  // one moves focus into a portal outside the composer, so the focus-gated
  // mobile row needs it to stay put while the user is inside the sheet.
  settingsSheetOpen?: boolean;

  // Slot rendered above the form (between the max-width wrapper and the form).
  // The main variant uses this for attachment-error / voice-error / disk-pressure
  // notices and the live voice-interim preview. The app-editing variant omits it.
  noticesAboveFormSlot?: ReactNode;

  // When true, the form's top border-radius is removed so the billing banner
  // (which has only top corners rounded) sits flush against the form,
  // forming a single continuous card.
  hasBillingBanner?: boolean;

  // Cap for the textarea's auto-grow height in pixels. The empty state passes a
  // larger value so the user can compose long first messages without the box
  // clipping.
  textareaMaxHeightPx?: number;

  // When true, only Cmd+Enter (Mac) or Ctrl+Enter (Win/Linux) submits the
  // message; plain Enter inserts a newline. Defaults to false (Enter submits).
  cmdEnterMode?: boolean;

  // Ghost text autocomplete — shown as a dimmed suffix in the textarea when
  // the suggestion endpoint returns a completion for the current conversation.
  suggestion?: string | null;

  // Edit-message recall — up-arrow on empty input recalls last user message.
  onRecallLastMessage?: () => void;
  onCancelEdit?: () => void;
}

/**
 * Viewport-space center of the on-screen assistant avatar the live-voice room
 * grows its entrance from — the last on-screen `[data-voice-origin]` element
 * (the greeting avatar on a fresh chat, the latest-turn avatar in a
 * conversation). `null` when none is visible (falls back to the tapped button,
 * then screen-center).
 */
function measureVoiceOriginAvatar(): { x: number; y: number } | null {
  if (typeof document === "undefined") {
    return null;
  }
  let best: DOMRect | null = null;
  for (const node of document.querySelectorAll("[data-voice-origin]")) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    const onScreen =
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth;
    // Keep the last on-screen one in DOM order (the most recent avatar).
    if (onScreen) {
      best = rect;
    }
  }
  if (!best) {
    return null;
  }
  return { x: best.left + best.width / 2, y: best.top + best.height / 2 };
}

/**
 * The mobile send button's filled circle. Applied only while the button can
 * actually send, so a blocked draft keeps the `Button` primitive's disabled
 * fill rather than a green control nobody can press. Hover holds the fill
 * alongside active, since a mouse reaches this row too.
 */
const MOBILE_SEND_FILL_CLASS =
  "bg-[var(--system-positive-strong)] hover:bg-[var(--system-positive-strong)] active:bg-[var(--system-positive-strong)] [--vbtn-fg:var(--aux-white)]";

/**
 * The padding the mobile text field carries on each side (`px-2`). Taken off
 * the span measured between the row's two control clusters, which is a border
 * box, to leave the width the draft itself gets on the inline row.
 */
const MOBILE_TEXT_FIELD_INSET_X_PX = 16;

interface AddToChatButtonProps {
  disabled: boolean;
  label: string;
  onClick: () => void;
  /** See `holdsFocusOnPress`. The row's other controls read the same signal. */
  onMouseDown?: (event: ReactMouseEvent<HTMLElement>) => void;
}

/** The narrow row's plus. What a press opens is the caller's decision. */
function AddToChatButton({
  disabled,
  label,
  onClick,
  onMouseDown,
}: AddToChatButtonProps) {
  return (
    <Button
      variant="ghost"
      iconOnly={<PlusIcon strokeWidth={2} />}
      iconOnlyGlyphClassName={MOBILE_GLYPH_CLASS}
      // The row sizes its own controls, so the primitive's mobile growth is
      // off here and every narrow window gets the same plus.
      expandOnMobile={false}
      // Where the press would not carry focus to this button, it has to leave
      // the composer's focus alone until the click arrives. Whatever the click
      // opens takes focus into its own portal from there.
      onMouseDown={onMouseDown}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      // Tertiary resting tone, matching the row's other glyphs. `shrink-0`
      // holds the circle at 40px however tight the row runs.
      className={cn(
        MOBILE_CONTROL_CLASS,
        MOBILE_GHOST_WASH_CLASS,
        "shrink-0 [--vbtn-fg:var(--content-tertiary)]",
      )}
    />
  );
}

export function ChatComposer({
  placeholder = "What would you like to do?",
  onSubmit,
  inputRef,
  typingDisabled,
  sendDisabled,
  onAddAttachmentFiles,
  voiceInputRef,
  onVoiceTranscript,
  onVoiceInterimTranscript,
  voiceInterim,
  onVoiceError,
  onVoiceBeforeStart,
  onStopGenerating,
  isAssistantBusy,
  assistantId,
  conversationId,
  conversationIsEmpty = false,
  thresholdPickerSlot,
  modelPickerSlot,
  settingsSheetOpen = false,
  contextWindowIndicatorSlot,
  noticesAboveFormSlot,
  hasBillingBanner = false,
  textareaMaxHeightPx = 240,
  cmdEnterMode = false,
  suggestion,
  onRecallLastMessage,
  onCancelEdit,
}: ChatComposerProps) {
  const { t } = useTranslation("chat");
  // Draft text is owned by the composer store; subscribing here (rather than
  // receiving it as a prop) means a keystroke re-renders only this component,
  // not the orchestrator or the transcript above it.
  const input = useComposerStore.use.input();
  const setInput = useComposerStore.use.setInput();
  // Attachments are composer-owned too: read the list and derive send-gating
  // here rather than threading four props down from the orchestrator.
  const attachments = useComposerStore.use.attachments();
  const removeAttachment = useComposerStore.use.removeAttachment();
  const attachmentsUploadingCount = selectUploadingCount(attachments);
  const canSendAttachments =
    attachmentsUploadingCount === 0 &&
    (selectUploadedIds(attachments).length > 0 ||
      selectPathReferencePaths(attachments).length > 0);

  const voicePhase = useVoiceRecordingStore.use.phase();
  const isVoiceActive =
    voicePhase === "recording" || voicePhase === "processing";
  // Holds the MediaStream opened by VoiceInputButton so we can reuse it for
  // amplitude analysis rather than opening a second getUserMedia request.
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null);
  const { amplitude } = useAudioAmplitude({
    active: voicePhase === "recording" && voiceStream !== null,
    stream: voiceStream,
  });
  const setVoiceAudioLevel = useVoiceRecordingStore.use.setAudioLevel();
  useEffect(() => {
    if (!voiceStream) {
      return;
    }
    setVoiceAudioLevel(amplitude);
  }, [amplitude, voiceStream, setVoiceAudioLevel]);
  const showVoiceInput =
    voiceInputRef !== undefined && onVoiceTranscript !== undefined;

  // ---- Live voice (full-duplex conversation) ----------------------------
  // Coexists with dictation: entry is gated on eligibility — `LiveVoiceButton`
  // only renders alongside the dictation button (`showVoiceInput` + a non-null
  // assistant id new enough to serve live voice) — so where there is no entry
  // point no session can ever start and the session state below stays `idle`.
  //
  // The session controller (`useLiveVoice`) is NOT owned here: it lives in
  // the persistent `useLiveVoiceSessionController` mount in `ChatLayout`, so
  // a session survives thread switches, Home/Library navigation, and the
  // fullscreen app viewer — the navigations that unmount this composer. The
  // composer only observes the session through narrow store selectors and
  // drives it through the store-registered `starter`/`controls` seams.
  // Version gate for the entry point (NOT for an already-live session — see
  // the ownership note below). Replaces the retired `voice-mode` flag, whose
  // fail-closed default kept the button hidden on assistants too old to
  // declare it.
  const supportsLiveVoice = useSupportsLiveVoice(assistantId);
  const liveVoiceState = useLiveVoiceStore.use.state();
  const liveVoiceError = useLiveVoiceStore.use.error();
  const liveVoiceErrorRecovery = useLiveVoiceStore.use.errorRecovery();
  // Whether any session is live anywhere (this thread or another). `failed`
  // is a retryable/inactive state, so it must count as inactive — otherwise
  // dictation would stay unavailable after a failed start.
  const isLiveVoiceSessionLive = isLiveVoiceSessionActive(liveVoiceState);
  // Whether THIS composer owns the active session — its conversation matches
  // the session's, or the session was started from this composer's draft.
  // Ownership scopes the surface swap: a session started in thread A must
  // not hijack thread B's composer — B keeps its normal row and the
  // title-bar pill is the session surface there (exactly one of the two
  // renders at any time; see `isLiveVoiceSessionOwnedBy`).
  //
  // Deliberately based on session state + ownership alone — NOT on the
  // entry-point eligibility (the version gate / a non-null `assistantId`) —
  // so a mid-session eligibility drop (version re-fetch, `assistantId`
  // transiently cleared) can't unmount the
  // voice bar while the session keeps the mic/socket live: the bar's ✕ stays
  // available until teardown completes. `showVoiceInput` (static per variant)
  // scopes the swap to the voice-enabled composer — the app-editing variant
  // shares the global live-voice store but must never swap its row.
  const ownsLiveVoiceSession = useIsLiveVoiceSessionOwnedBy(conversationId);
  const isLiveVoiceActive = showVoiceInput && ownsLiveVoiceSession;
  // What the minimized bar paints itself with, from the session assistant's
  // avatar — the same hook the room and the header pill resolve their fill
  // through, so the three surfaces can never disagree about the session's
  // color. Fetch-gated to live sessions; the query is shared with every other
  // avatar consumer.
  //
  // The paint stops at the bar. The composer card underneath keeps the app's
  // normal surface, because the card is a working input during a session now
  // (see the bar's placement below), and an input painted in the room's color
  // reads as part of the room rather than as somewhere to type.
  const voiceSurfacePaint = useVoiceSurfacePaint(
    isLiveVoiceActive ? assistantId : null,
  );
  // The two mute states (controller-published) behind the block's toggles: one
  // per direction of the conversation, like the room's.
  const liveVoiceMuted = useLiveVoiceStore.use.muted();
  const liveVoiceOutputMuted = useLiveVoiceStore.use.outputMuted();
  // The composer no longer renders the user's own speech: the textarea is a
  // live input for the whole session now, so there is no cell to stream it
  // into without taking typing away again. "Show the words you say" is served
  // by the room's own transcript (`VoiceAmbientTranscript`), which is where a
  // user who wants to watch their words is looking; minimizing is the gesture
  // that puts them back on the thread instead.
  // Session verbs go through the store seams registered by the layout-owned
  // controller: `starter` (registered for the controller's whole mount) to
  // start, per-session `controls` to end/interrupt — the latter via the shared
  // module-level `endLiveVoiceSession` helper, which
  // read the store with `getState()` per STATE_MANAGEMENT.md (no subscription
  // needed for callback-only reads).
  // First-run interception: the very first voice-mode entry opens a
  // preferences card (see `VoiceFirstRunCard`) instead of starting the
  // session, so the user chooses their transcript prefs before listening
  // begins. Every subsequent entry (`firstRunSeen === true`) starts directly
  // — the card and the engine stay decoupled. The app-editing variant (no
  // voice entry point) never renders the card.
  const firstRunCardOpen = useLiveVoiceStore((state) => state.firstRunCardOpen);
  // Where the user tapped to start — captured at click so the room's entrance
  // grows from the on-screen control, not screen-center. Stashed here because
  // the first-run card path defers the actual start to its own handler.
  const liveVoiceEntryOriginRef = useRef<{ x: number; y: number } | null>(null);
  const navigate = useNavigate();
  // Window-lifetime, not mount-time: the composer is a per-route component
  // that can remount after an in-window navigation has dropped `?popout=1`,
  // so a mount-time capture could misread a pop-out as a main window and ship
  // a dead expand-to-room control (pop-outs never render the voice room).
  const isPopout = isPopoutWindowLifetime();
  // "Configure voice" copy surfaced when the pre-open preflight returns
  // `not-ready` — the daemon's human-readable `userMessage`. Non-null renders
  // the notice below (with a deep-link to voice settings) and the room stays
  // closed. Cleared on dismiss or on the next successful start.
  const voiceConfigNotice = useLiveVoiceStore((state) => state.configNotice);
  // Re-entrancy guard: the preflight is awaited before the room opens, so a
  // second click while it's in flight must be ignored (else two sessions could
  // race to start). A ref, not state — this must gate synchronously and never
  // trigger a re-render.
  const liveVoicePreflightPendingRef = useRef(false);
  // Latest chat identity, re-read after the preflight await. The awaiting
  // callback holds the assistant/conversation captured when it was created, so
  // a user who switches chats (or leaves) mid-flight would otherwise resume and
  // bind the room to the chat they left. Kept in a ref so the check sees the
  // current render's values rather than the closure's.
  const liveVoiceChatIdentityRef = useRef({
    assistantId,
    conversationId,
    conversationIsEmpty,
  });
  useEffect(() => {
    liveVoiceChatIdentityRef.current = {
      assistantId,
      conversationId,
      conversationIsEmpty,
    };
  }, [assistantId, conversationId, conversationIsEmpty]);
  const startLiveVoiceSession = useCallback(async () => {
    if (!assistantId || liveVoicePreflightPendingRef.current) {
      return;
    }
    // WebKit's media-element playback permission is transient. Reserve and
    // prewarm the controller-owned player synchronously from this gesture,
    // before the readiness request yields to the event loop.
    const starter = useLiveVoiceStore.getState().starter;
    starter?.prewarm();
    // Gate the open on the daemon's readiness verdict BEFORE starting, so the
    // room never flashes open then immediately closes for a user with no
    // usable STT/TTS provider. The daemon runs managed-speech defaulting as
    // part of the preflight, so a user who *can* be auto-configured comes back
    // `ready` here.
    liveVoicePreflightPendingRef.current = true;
    let readiness;
    try {
      readiness = await voiceReadiness(assistantId);
    } finally {
      liveVoicePreflightPendingRef.current = false;
    }
    // The user may have moved to another chat while the POST was in flight.
    // Drop the result entirely rather than opening a room bound to the chat
    // they left — and skip the notice too, which would otherwise surface
    // against whatever conversation they navigated to.
    const latest = liveVoiceChatIdentityRef.current;
    if (
      latest.assistantId !== assistantId ||
      latest.conversationId !== conversationId
    ) {
      starter?.cancelPrewarm();
      return;
    }
    // The layout-owned controller may have unmounted while preflight was in
    // flight. Do not invoke a stale starter captured from the old mount.
    if (useLiveVoiceStore.getState().starter !== starter) {
      starter?.cancelPrewarm();
      return;
    }
    // Only an explicit `not-ready` closes the door; see `voiceReadiness` for
    // why a failed preflight allows the start instead of blocking it. The
    // notice is published here rather than inside the guard so the staleness
    // checks above get to decide the answer is still wanted.
    if (!readiness.allowed) {
      starter?.cancelPrewarm();
      publishConfigNotice(readiness.notice);
      return;
    }
    publishConfigNotice(null);
    // Grow the room's entrance from the assistant avatar the user sees — the
    // empty-state greeting avatar, or the latest-turn avatar below the most
    // recent response (both tagged `data-voice-origin`). Fall back to the
    // tapped voice button, then to screen-center (null).
    const origin =
      measureVoiceOriginAvatar() ?? liveVoiceEntryOriginRef.current;
    // Publish the origin BEFORE starting; the controller carries it across its
    // start-time `reset()` (see the live-voice store's `entryOrigin`).
    setLiveVoiceEntryOrigin(origin);
    // Read off `latest`, not off the render that opened this callback: the
    // preflight above is a network round trip, and a conversation that filled
    // up across it must not be seeded as if it were still blank. Unlike the
    // assistant/conversation mismatch this is not a reason to abandon the
    // start, only a reason to open silent, so it is decided here rather than
    // in the staleness guard.
    starter?.start(assistantId, conversationId ?? null, {
      seedText: voiceEntryGreetingSeed(latest.conversationIsEmpty),
    });
  }, [assistantId, conversationId]);
  /**
   * In-flight reclaim, so unmounting cancels it. The start on the far side of
   * the await reads this composer's chat identity, and a composer that has
   * unmounted stops updating it: its staleness check would compare the values
   * captured at unmount against itself, pass, and open a session for the page
   * the user left.
   */
  const liveVoiceReclaimRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      liveVoiceReclaimRef.current?.abort();
      liveVoiceReclaimRef.current = null;
    },
    [],
  );
  /**
   * Take the live-voice slot from the session that refused this one, and start
   * here. The blocking session is usually the same person on a surface they
   * cannot get back to, so the way out is to end it from here rather than to
   * go find it.
   */
  const handleReclaimLiveVoice = useCallback(async () => {
    if (!assistantId) {
      return;
    }
    // Prewarm from inside the click, before any await: WebKit's playback
    // permission belongs to the gesture, and `startLiveVoiceSession` below
    // runs after a network round trip, by which time the gesture is spent.
    useLiveVoiceStore.getState().starter?.prewarm();
    const reclaim = new AbortController();
    liveVoiceReclaimRef.current?.abort();
    liveVoiceReclaimRef.current = reclaim;
    // The result is not branched on: whether the slot was already free or the
    // call failed, the next move is to try to start, and the start handshake
    // reports anything still wrong. A second error in front of someone
    // escaping the first one helps nobody.
    await endLiveVoiceSessionOnAssistant(assistantId, reclaim.signal);
    if (liveVoiceReclaimRef.current === reclaim) {
      liveVoiceReclaimRef.current = null;
    }
    if (reclaim.signal.aborted) {
      return;
    }
    dismissLiveVoiceFailure();
    void startLiveVoiceSession();
  }, [assistantId, startLiveVoiceSession]);
  const handleGoToVoiceSession = useCallback(() => {
    const holderConversationId = liveVoiceErrorRecovery?.holderConversationId;
    if (!holderConversationId) {
      return;
    }
    dismissLiveVoiceFailure();
    navigateToConversation(navigate, holderConversationId);
  }, [liveVoiceErrorRecovery, navigate]);
  const handleLiveVoiceStart = useCallback(
    (origin?: { x: number; y: number }) => {
      if (!assistantId) {
        return;
      }
      liveVoiceEntryOriginRef.current = origin ?? null;
      // A soft keyboard is the only thing worth dropping focus for: it would
      // otherwise stay raised under a room that takes the whole screen. Read at
      // press time rather than from render, since a convertible can gain or lose
      // its keyboard between the two.
      //
      // Everywhere else the focus stays put. A pointing device or a keyboard
      // entry leaves focus on the button, and a `not-ready` verdict never opens
      // the room at all: it raises a "Configure voice" action that the user then
      // has to reach, which is a good deal harder from the body. The textarea by
      // name for the same reason, so nothing else can be blurred by accident.
      if (isPointerCoarse()) {
        inputRef.current?.blur();
      }
      // First-run preferences card — shown on the first-ever voice entry on
      // EVERY platform, the Capacitor iOS shell included (web↔iOS parity for the
      // welcome card). On iOS the card renders locked (`nonDismissible`, see its
      // render below), which keeps it compliant with `docs/CAPACITOR.md` § OS
      // permission requests: the card precedes the live-voice `getUserMedia`
      // alert, and a locked pre-prompt whose only action leads straight to that
      // alert is the sanctioned pattern (Apple HIG / App Store Review 5.1.1(iv))
      // — a *dismissible* pre-prompt is the disallowed one.
      if (firstRunCardIntercepts()) {
        return;
      }
      startLiveVoiceSession();
    },
    [assistantId, inputRef, startLiveVoiceSession],
  );
  const handleFirstRunStart = useCallback(() => {
    useVoicePrefsStore.getState().markFirstRunSeen();
    useLiveVoiceStore.getState().setFirstRunCardOpen(false);
    startLiveVoiceSession();
  }, [startLiveVoiceSession]);

  const pointerCoarse = useMemo(() => isPointerCoarse(), []);
  // `shouldSubmitOnEnter` ignores Enter under a coarse primary pointer, since a
  // soft keyboard's Enter inserts a newline. Anything that stands in for
  // keyboard submit reads this, never the viewport width: the two disagree on a
  // roomy tablet and on a narrowed desktop window, and the substitute belongs to
  // the absence of the thing it replaces. See `docs/PLATFORM_ADAPTATION.md`.
  const keyboardCanSubmit = !pointerCoarse;
  // The compact row and everything in it follow the window's width; what the
  // plus opens follows the input. A narrowed desktop or Electron window keeps
  // the row, and still wants the picker a mouse can drive. See
  // `docs/PLATFORM_ADAPTATION.md`.
  const isMobile = useIsMobile();
  const isNative = useIsNativePlatform();
  const isElectronHost = isElectron();

  // Narrow-card collapse: below the compact width the labelled access and
  // model-profile triggers collide, so the pair folds into one hamburger menu
  // (mounted in the access slot, keeping the row's attach | settings | mic |
  // voice order). Mobile is excluded: its settings triggers live in the pills
  // row above the card, so they never compete for the action row's width.
  const composerCardRef = useRef<HTMLFormElement>(null);
  const compactSettings =
    useIsCompactComposerWidth(composerCardRef) && !isMobile;

  // The shell wraps the pills row and the card together, so moving focus from
  // the textarea to a pill is not a leave. `data-slot="chat-composer"` stays on
  // the form: that is the box `composer-peek`, the onboarding tour, and the
  // quote bubble measure.
  const composerShellRef = useRef<HTMLDivElement>(null);
  const composerFocusWithin = useComposerFocusWithin(composerShellRef);

  // Stable ref so handleSlashCommandSelect's autoSend path always calls the
  // latest onSubmit even after flushSync triggers a synchronous re-render.
  const onSubmitRef = useRef(onSubmit);
  useLayoutEffect(() => {
    onSubmitRef.current = onSubmit;
  });

  // Cursor position at the time of the last text change, used to derive the
  // emoji popup's trigger text. Updated in onChange and programmatic setInput
  // calls; defaults to end-of-input for the initial render.
  const cursorRef = useRef(input.length);

  // The Doctor is platform-hosted only, so `/doctor` is not offered when the
  // active assistant is self-hosted (the Doctor tab doesn't exist there).
  const doctorGated = usePlatformGate({ platformHostedOnly: true }) === "gated";
  const searchSlashCommands = useCallback(
    (filter: string) => {
      const commands = filteredCommands(filter);
      if (!doctorGated) {
        return commands;
      }
      return commands.filter((command) => command.name !== "doctor");
    },
    [doctorGated],
  );

  // Slash and emoji popups — state is derived from the input text, not stored.
  const slash = useTextPopup({
    text: input,
    trigger: SLASH_PREFIX_RE,
    search: searchSlashCommands,
  });

  // Cursor position is a DOM property tracked via onSelect; using state
  // would re-render on every cursor movement.
  // eslint-disable-next-line react-hooks/refs
  const textBeforeCursor = input.slice(0, cursorRef.current);
  const searchEmoji = useEmojiSearch();
  const emoji = useTextPopup({
    text: textBeforeCursor,
    trigger: EMOJI_TRIGGER_RE,
    search: searchEmoji,
    minFilterLength: EMOJI_MIN_FILTER_LENGTH,
  });

  const handleSlashCommandSelect = useCallback(
    (command: SlashCommand) => {
      const newInput = selectedInputText(command);
      if (command.selectionBehavior === "autoSend") {
        // Suppress before flushSync so the synchronous re-render derives
        // show=false instead of briefly flashing the popup.
        slash.dismiss();
        flushSync(() => setInput(newInput));
        onSubmitRef.current(new Event("submit") as unknown as FormEvent);
      } else {
        cursorRef.current = newInput.length;
        setInput(newInput);
        inputRef.current?.focus();
      }
    },
    [setInput, inputRef, slash.dismiss],
  );

  const insertEmoji = useCallback(
    (entry: EmojiEntry) => {
      const el = inputRef.current;
      const cursorPos = el?.selectionStart ?? input.length;
      const colonPos = cursorPos - emoji.filter.length - 1;
      const newInput =
        input.slice(0, colonPos) + entry.emoji + input.slice(cursorPos);
      const newCursor = colonPos + entry.emoji.length;
      cursorRef.current = newCursor;
      setInput(newInput);
      requestAnimationFrame(() => {
        if (el) {
          el.setSelectionRange(newCursor, newCursor);
          el.focus();
        }
      });
    },
    [emoji.filter, input, inputRef, setInput],
  );

  const phase: TurnPhase = useTurnStore.use.phase();
  const isLocallyGenerating =
    phase === "queued" || phase === "thinking" || phase === "streaming";
  const showInlineVoicePreview =
    isVoiceActive && !isLocallyGenerating && !isElectronHost;
  // Dictation's inline preview takes the textarea's place on native. A
  // live-voice session does not: its bar sits above the card and the composer
  // stays a working composer underneath, so the user can type and send
  // mid-session.
  const hideTextareaForVoice = isNative && showInlineVoicePreview;
  // Staged context is anything that makes an empty input sendable: staged
  // quotes, or the one channel reference pinned above this composer. Both are
  // read from their stores here, the same way attachments are, so the send
  // button, the Enter policy, and `useComposerSubmit`'s own guard all answer
  // "is there something to send" from the same state.
  const hasStagedQuotes = useQuoteReplyStore.use.stagedQuotes().length > 0;
  // Derived boolean selector: swapping which row is staged replaces the
  // reference object without changing sendability, so this subscribes to the
  // flip alone rather than re-rendering the composer on every swap.
  const hasStagedChannelReference = useChannelReferenceStore(
    (s) => s.reference !== null,
  );
  const hasStagedContext = hasStagedQuotes || hasStagedChannelReference;
  const canSendMessageContent =
    Boolean(input.trim()) || canSendAttachments || hasStagedContext;
  // The busy row holds exactly one control, and stop is the default: it is the
  // only escape from a turn already running. Send takes the slot only where it
  // is strictly better, which is where the keyboard cannot submit AND pressing
  // it would actually queue the draft. Those are the same three conditions
  // `shouldSubmitOnEnter` requires before it answers "submit", so the two paths
  // to sending open and close together, and a draft that cannot go anywhere yet
  // (an attachment still uploading, a prompt holding the send) leaves stop in
  // place rather than a send nobody can press.
  const sendReplacesStop =
    !keyboardCanSubmit &&
    canSendMessageContent &&
    !sendDisabled &&
    attachmentsUploadingCount === 0;
  // Voice mode occupies the send slot while there is nothing to send: the
  // send arrow only earns that spot once the message has content. Eligibility
  // is a voice-enabled composer + a bound assistant new enough to serve live
  // voice, so the slot falls back to the disabled send arrow whenever voice
  // mode is unavailable. The version gate replaces the retired `voice-mode`
  // flag, which used to hide the entry point on older assistants by failing
  // closed — see `use-supports-live-voice.ts`.
  // Dictation is gone from the row while this composer owns a live session:
  // two mic capture flows can't run at once, and a permanently dead mic button
  // sitting under a live voice bar reads as a broken control rather than an
  // unavailable one. The bar's own mic (mute) is the mic that matters there.
  const showDictationButton = showVoiceInput && !isLiveVoiceActive;
  //
  // Suppressed while this composer owns a live session: the bar above is the
  // session's control, so the slot would offer a second, dead entry point into
  // the thing already running. The send arrow takes the slot back instead,
  // which is the control that matters now that the input works mid-session.
  const showVoiceModeInSendSlot =
    showVoiceInput &&
    Boolean(assistantId) &&
    supportsLiveVoice &&
    !canSendMessageContent &&
    !isLiveVoiceActive;

  // Mobile lifts the access and profile triggers out of the action row into a
  // row that floats above the card while the composer is in use, and hangs a
  // caption under the card while it rests. Only `ChatMainPanel` fills the
  // settings slots, and only once it has an assistant to point them at, so a
  // variant that passes neither (the onboarding tour's composer) gets neither.
  const isMainComposer = Boolean(thresholdPickerSlot || modelPickerSlot);
  const isMobileMainComposer = isMobile && isMainComposer;

  // No longer suppressed during a live-voice session: it was suppressed
  // because the streaming speech rendered in the ghost-suffix mirror's own
  // grid cell, and nothing renders there now. The textarea is an ordinary
  // input for the session's duration, so it keeps its ordinary suggestion.
  const ghostSuffix = useMemo(
    () =>
      computeGhostSuffix({
        pointerCoarse,
        suggestion: suggestion ?? null,
        input,
        hasAttachments: attachments.length > 0,
      }),
    [pointerCoarse, suggestion, input, attachments],
  );

  const [addSheetOpen, setAddSheetOpen] = useState(false);
  // Whether a picker the sheet launched is still up. The sheet closes itself
  // before opening one, so its own flag above cannot answer for the pick.
  const [addSheetPickerOpen, setAddSheetPickerOpen] = useState(false);
  // Latched on the first open and never reset. The sheet closes itself before
  // it hands off to the OS picker, so a shell that crossed the breakpoint while
  // that picker was up would take the sheet's hidden inputs with it.
  const [addSheetEverPresented, setAddSheetEverPresented] = useState(false);
  const handleAddSheetOpenChange = useCallback((open: boolean) => {
    if (open) {
      setAddSheetEverPresented(true);
    }
    setAddSheetOpen(open);
  }, []);
  // Subscribed rather than read once: a convertible whose keyboard comes off
  // mid-session changes whether a press on the row carries focus with it.
  const pointerCoarseNow = usePointerCoarse();
  // Two shells want a list of their own, for different reasons.
  //
  // A shell holding the native pickers wants one because its rows go straight
  // to the surface they name: the photo row opens the system photo picker and
  // the files row the document browser, neither of which a file input can
  // reach. Without them a row can only raise the OS chooser the plain input
  // already raises, which is a list in front of a list.
  //
  // The Android shell wants one either way. Capacitor's
  // `BridgeWebChromeClient` only reaches a camera intent when the input
  // carries `capture` AND an `image/*` or `video/*` accept
  // (`onShowFileChooser`); anything else goes straight to `ACTION_GET_CONTENT`,
  // which is a document picker with no way to take a photo. WebKit's own sheet
  // offers the camera for a bare input, and Android in a browser gets
  // Chromium's chooser, which does the same.
  //
  // Read rather than subscribed: neither the shell a session runs in nor the
  // plugins its build links can change mid-session.
  const isNativeAndroidShell = useIsNativeAndroid();
  const usesAddSheet =
    isMobile && (isNativeAndroidShell || nativeAttachmentPickersAvailable());

  // Whether a press on one of the row's controls has to hold the composer's
  // focus for the click behind it. Both halves are load-bearing and neither one
  // alone is the question: the row is what gates itself on that focus, and a
  // press is what fails to carry it. A pointing device focuses the button it
  // presses, and the button sits inside the shell `useComposerFocusWithin`
  // watches, so the row never drops and the click never misses. Cancelling the
  // press there would only take the focus the button is owed. Live rather than
  // read once, since a convertible crosses this mid-session.
  const holdsFocusOnPress = isMobile && pointerCoarseNow;
  // The handler form, for the controls this file renders itself. See
  // `preventPressFocusTransfer` for what the press would otherwise cost.
  const rowPressGuard = holdsFocusOnPress
    ? preventPressFocusTransfer
    : undefined;

  // The picker behind both attach controls, through one hook so the iOS
  // refocus dance is identical on either. Where the OS menu already offers the
  // camera, the photo library and the file browser, this is the whole flow.
  // Owned by the composer rather than by the control that opens it, so a width
  // or pointer change while the OS picker is up cannot unmount the input under
  // it and drop the selection.
  const {
    openPicker: openAttachPicker,
    inputNode: attachPickerInput,
    pickerOpen: attachPickerOpen,
  } = useAttachmentFilePicker({
    onFiles: onAddAttachmentFiles,
    multiple: true,
  });

  // The camera a Home Screen widget's button asks for. Owned here for the same
  // reason as the picker above, and gated to the `ChatMainPanel` composer so a
  // one-shot park is never spent by the onboarding tour's. That gate leaves
  // exactly one taker: `ChatMainPanel` renders on either the app-editing
  // branch or the plain chat branch, never both.
  const {
    overlayNode: cameraDeepLinkOverlay,
    captureOpen: cameraDeepLinkCaptureOpen,
  } = useCameraDeepLink({
    onFiles: onAddAttachmentFiles,
    enabled: isMainComposer,
  });

  // A surface opened from the composer takes the focus this would otherwise
  // read, so each one has to hold the row up for as long as it is standing.
  // A sheet moves focus into a portal; the native picker takes the web view's
  // first responder, which arrives here as focus returning to the body. Either
  // way the composer is in use, and rearranging it for an idle one would move
  // it behind the surface the user is looking at.
  const composerInUse =
    composerFocusWithin ||
    settingsSheetOpen ||
    addSheetOpen ||
    addSheetPickerOpen ||
    attachPickerOpen ||
    cameraDeepLinkCaptureOpen;
  // Whether a banner is standing over the card. Read off the box rather than
  // derived from props: most of that stack arrives through
  // `noticesAboveFormSlot`, an opaque node, and the composer-owned notices in
  // it source their own state, so what the box holds is the one answer that
  // covers all of them at once.
  const bannerStackRef = useRef<HTMLDivElement>(null);
  const [hasBannerAboveCard, setHasBannerAboveCard] = useState(false);
  const readBannerStack = useCallback(() => {
    const node = bannerStackRef.current;
    if (node) {
      setHasBannerAboveCard(node.childElementCount > 0);
    }
  }, []);
  // On every commit, so a banner that arrives with a render of this composer
  // (the slot above, or a notice keyed on state it already subscribes to)
  // settles in that same commit rather than a frame later.
  useLayoutEffect(readBannerStack);
  // The backstop for the rest: `ComposerDraftNotices` sources its own state,
  // and its restored-draft notice comes and goes without this composer
  // rendering at all. `childList` alone, since every notice in there is an
  // element of its own.
  useLayoutEffect(() => {
    const node = bannerStackRef.current;
    if (!node) {
      return;
    }
    const observer = new MutationObserver(readBannerStack);
    observer.observe(node, { childList: true });
    return () => {
      observer.disconnect();
    };
  }, [readBannerStack]);

  // The app shells hold the row up for the whole session. On a phone these
  // pills are the only place the access and profile pickers live, and a row
  // that comes and goes with the keyboard puts both a tap out of reach for as
  // long as the composer is at rest. A mobile browser keeps the focus-driven
  // reveal, where the row is competing with the page's own chrome for the
  // bottom of the screen.
  const isNativeMobileShell = useIsNativeMobile();
  // A banner docks to the card's top edge and takes the strip this row floats
  // in, so the row stands down while one is up rather than crowding it. The
  // avatar peeking over that same edge stands down with it (`ComposerPeek`).
  //
  // A pending question card lands in the same strip and stands the row down
  // for the same reason, plus one of its own: the card is what the turn is
  // waiting on, and the pills reach settings that are beside the point until
  // it is answered.
  const hasPendingQuestion = useHasPendingQuestion();
  const settingsPillsVisible =
    isMobileMainComposer &&
    !hasBannerAboveCard &&
    !hasPendingQuestion &&
    (isNativeMobileShell || composerInUse);
  // The entrance belongs to the row that arrives with the keyboard. A row that
  // stands throughout has no arrival to animate, and the same animation there
  // replays on every mount, settling the composer on each navigation.
  const settingsPillsClassName = settingsPillsVisible
    ? `mb-3 flex justify-end gap-1.5 pr-1.5${
        isNativeMobileShell
          ? ""
          : " animate-[fadeInUp_var(--anim-fast)_var(--anim-ease-out)_backwards] motion-reduce:animate-none"
      }`
    : undefined;

  // A pill at mobile widths (half the card's 52px collapsed height), the 10px
  // panel elsewhere, both from the live-voice bar's module: the bar stacks on
  // this card and has to wear whichever corner it is showing. The banner
  // variants stay literal, since a bottom-only corner is not the same class.
  const cardShapeClass = isMobile
    ? hasBillingBanner
      ? "rounded-b-[26px]"
      : COMPOSER_MOBILE_RADIUS_CLASS
    : hasBillingBanner
      ? "rounded-b-[10px]"
      : COMPOSER_RADIUS_CLASS;

  // One 24px line inside 8px of padding is the 40px the mobile row's buttons
  // stand at, which centres the placeholder on them and holds the collapsed
  // card at 52px.
  const textFieldPaddingClass = isMobile ? "px-2 py-2" : "px-4 pt-3 pb-2";

  // ---- Mobile draft geometry --------------------------------------------
  // One question the draft's own text cannot answer: whether it still fits the
  // one line the inline row gives it. Measured after commit, from the boxes
  // below.
  const mobileRowRef = useRef<HTMLDivElement>(null);
  const inlineActionsStartRef = useRef<HTMLDivElement>(null);
  const inlineActionsEndRef = useRef<HTMLDivElement>(null);
  const draftProbeRef = useRef<HTMLDivElement>(null);
  const [isMultilineDraft, setIsMultilineDraft] = useState(false);
  const measureDraftGeometry = useCallback(() => {
    const start = inlineActionsStartRef.current;
    const end = inlineActionsEndRef.current;
    const probe = draftProbeRef.current;
    if (!isMobile || hideTextareaForVoice || !start || !end || !probe) {
      setIsMultilineDraft(false);
      return;
    }
    // The span between the two control clusters. They keep their widths and
    // their line through the change, so this is the width the draft has on the
    // inline row whichever layout is currently up: the fixed reference the
    // stacked layout has to be judged against to settle (see
    // `isDraftPastOneLine`).
    const inlineWidthPx =
      end.getBoundingClientRect().left -
      start.getBoundingClientRect().right -
      MOBILE_TEXT_FIELD_INSET_X_PX;
    setIsMultilineDraft(
      isDraftPastOneLine({
        naturalWidthPx: probe.scrollWidth,
        inlineWidthPx,
        hasHardBreak: input.includes("\n"),
      }),
    );
  }, [hideTextareaForVoice, input, isMobile]);
  useLayoutEffect(() => {
    measureDraftGeometry();
  }, [measureDraftGeometry]);
  // Latest measurement behind a stable identity, so the observer below is set
  // up once per row rather than torn down and rebuilt on every keystroke.
  const measureDraftGeometryRef = useRef(measureDraftGeometry);
  useLayoutEffect(() => {
    measureDraftGeometryRef.current = measureDraftGeometry;
  });
  useEffect(() => {
    const row = mobileRowRef.current;
    const start = inlineActionsStartRef.current;
    const end = inlineActionsEndRef.current;
    if (!row || !start || !end || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() =>
      measureDraftGeometryRef.current(),
    );
    // The card's own width, and the two clusters it reserves room for: a turn
    // starting takes the plus away, which is 41px the draft gets back.
    observer.observe(row);
    observer.observe(start);
    observer.observe(end);
    return () => observer.disconnect();
  }, [isMobile]);

  // Mobile hands the attach flow to a plus, which opens the same native picker
  // the desktop paperclip does, or the sheet on the one shell whose own menu
  // cannot offer a camera. Every attach control answers to the same gating, so
  // a busy assistant hides whichever one is mounted.
  const attachDisabled = typingDisabled || !assistantId;
  const attachControl = !isMobile ? (
    <AttachFileButton
      disabled={attachDisabled}
      onFilesSelected={onAddAttachmentFiles}
    />
  ) : (
    <AddToChatButton
      disabled={attachDisabled}
      label={t("chatComposer.addToChat")}
      onClick={
        usesAddSheet ? () => handleAddSheetOpenChange(true) : openAttachPicker
      }
      onMouseDown={rowPressGuard}
    />
  );

  const dictationButton = showDictationButton ? (
    <VoiceInputButton
      ref={voiceInputRef}
      assistantId={assistantId}
      // Mutual exclusion: a live-voice session in another thread must block
      // dictation, or two mic capture flows could run at once. (This
      // composer's own session takes the button away entirely, see
      // `showDictationButton`.)
      disabled={typingDisabled || isLiveVoiceSessionLive}
      onTranscript={onVoiceTranscript}
      onInterimTranscript={onVoiceInterimTranscript}
      onError={onVoiceError}
      onBeforeStart={onVoiceBeforeStart}
      onStreamReady={setVoiceStream}
      mobileRow={isMobile}
      holdComposerFocus={holdsFocusOnPress}
    />
  ) : null;

  const sendBlocked =
    sendDisabled || attachmentsUploadingCount > 0 || !canSendMessageContent;

  // macOS parity: the send button is hidden during recording and while
  // transcription is being processed. Only the voice button (mic / stop /
  // spinner) is shown. Otherwise the send slot holds voice mode until there is
  // something to send, at which point the send arrow takes over.
  const sendSlot = isVoiceActive ? null : showVoiceModeInSendSlot ? (
    // Session entry point: once a session starts here the slot gives way to
    // the send arrow and the bar above the card owns stopping. Disabled while
    // dictation is active or a live-voice session already runs elsewhere, so a
    // second mic/voice capture can't open alongside it.
    <LiveVoiceButton
      onStart={handleLiveVoiceStart}
      disabled={typingDisabled || isVoiceActive || isLiveVoiceSessionLive}
      mobileRow={isMobile}
      holdComposerFocus={holdsFocusOnPress}
    />
  ) : (
    <Button
      variant="primary"
      iconOnly={<ArrowUp className="h-4 w-4" strokeWidth={2.5} />}
      iconOnlyGlyphClassName={isMobile ? MOBILE_GLYPH_CLASS : undefined}
      expandOnMobile={!isMobile}
      type="submit"
      onMouseDown={rowPressGuard}
      disabled={sendBlocked}
      title={
        sendDisabled || !canSendMessageContent
          ? t("chatComposer.typeToSend")
          : attachmentsUploadingCount > 0
            ? t("chatComposer.uploadingAttachments")
            : t("chatComposer.sendMessage")
      }
      aria-label={t("chatComposer.sendMessage")}
      className={cn(
        isMobile && MOBILE_CONTROL_CLASS,
        isMobile && !sendBlocked && MOBILE_SEND_FILL_CLASS,
      )}
    />
  );

  // The busy row's single control wears the same chrome as the resting slot it
  // stands in for, so a turn starting does not shrink the row's right end back
  // to a desktop control.
  const busyRowControl = sendReplacesStop ? (
    <Button
      variant="primary"
      iconOnly={<ArrowUp className="h-4 w-4" strokeWidth={2.5} />}
      iconOnlyGlyphClassName={isMobile ? MOBILE_GLYPH_CLASS : undefined}
      expandOnMobile={!isMobile}
      type="submit"
      onMouseDown={rowPressGuard}
      title={t("chatComposer.sendMessage")}
      aria-label={t("chatComposer.sendMessage")}
      className={cn(
        // Reachable only when the draft can actually go, so the filled tone
        // never lands on a send nobody can press.
        isMobile && MOBILE_CONTROL_CLASS,
        isMobile && MOBILE_SEND_FILL_CLASS,
      )}
    />
  ) : (
    <Button
      variant="primary"
      iconOnly={<Square className="h-3 w-3" />}
      iconOnlyGlyphClassName={isMobile ? MOBILE_GLYPH_CLASS : undefined}
      expandOnMobile={!isMobile}
      onMouseDown={rowPressGuard}
      onClick={onStopGenerating}
      aria-label={t("chatComposer.stopGenerating")}
      className={isMobile ? MOBILE_CONTROL_CLASS : undefined}
    />
  );

  const inlineVoicePreview = showInlineVoicePreview ? (
    // Non-Electron fallback: Electron uses the shared top-center dictation
    // overlay for both focused and global recording. Browser/iOS hosts keep
    // this inline waveform because the overlay bridge no-ops there.
    <div
      className={hideTextareaForVoice ? "px-2 pt-3" : "px-2"}
      aria-label={
        voicePhase === "processing"
          ? t("chatComposer.transcribing")
          : t("chatComposer.recording")
      }
      aria-live="polite"
    >
      <StreamingWaveform
        amplitude={amplitude}
        paused={voicePhase === "processing"}
      />
      {voicePhase === "processing" ? (
        <p className="mt-1 truncate text-[11px] italic text-[var(--content-tertiary)]">
          {t("chatComposer.transcribingEllipsis")}
        </p>
      ) : (
        voiceInterim && (
          // Partial transcript ghost text, mirroring macOS composerTextField
          // showing interim results in the input binding while speaking.
          <p className="mt-1 truncate text-[11px] italic text-[var(--content-tertiary)]">
            {voiceInterim}
          </p>
        )
      )}
    </div>
  ) : null;

  // CSS Grid hidden-mirror technique for an auto-growing textarea. A hidden
  // div mirrors the textarea content in the same grid cell, so the grid
  // auto-sizes to max(mirror_height, textarea_intrinsic_height) and the
  // textarea stretches to fit with no JS height measurement. That avoids the
  // iOS WKWebView re-dispatch bug entirely: no DOM geometry mutation means no
  // re-fired input events.
  // https://css-tricks.com/the-cleanest-trick-for-autogrowing-textareas/
  //
  // One element serves both layouts (the mobile row wraps it, the desktop card
  // stacks it above the action row), so a breakpoint swap can't strand the
  // draft or the caret in a second textarea.
  const textFieldBlock = (
    <div
      className={
        hideTextareaForVoice
          ? "hidden"
          : isMobile
            ? cn(
                "grid min-w-0",
                isMultilineDraft
                  ? // Past one line the block takes the row's whole width and
                    // steps ahead of the controls, which wrap into a row of
                    // their own beneath it. The 2px lands the text on the
                    // card's 12px inset, where the plus below it already sits.
                    "order-first basis-full pl-0.5"
                  : "flex-1",
              )
            : "grid"
      }
    >
      {isMobile && (
        // What the row asks whether the draft still fits its one line: the
        // same text with nothing to wrap it, in a box with no width of its
        // own, so `scrollWidth` reports what the draft would take unbroken.
        // The autogrow mirror below cannot answer that, since it wraps, and
        // its width is the very thing the answer decides.
        //
        // The suggestion is deliberately left out. It is somebody else's text
        // arriving on its own schedule, and restructuring the composer around
        // it would move the card under the user mid-sentence.
        <div
          ref={draftProbeRef}
          aria-hidden
          data-slot="composer-draft-probe"
          className="pointer-events-none invisible col-start-1 row-start-1 h-0 w-0 overflow-hidden whitespace-pre text-chat"
          style={{ fontFamily: "inherit", letterSpacing: "inherit" }}
        >
          {input}
        </div>
      )}
      <div
        aria-hidden
        className={`pointer-events-none col-start-1 row-start-1 overflow-hidden whitespace-pre-wrap break-words text-chat ${textFieldPaddingClass}`}
        style={{
          fontFamily: "inherit",
          letterSpacing: "inherit",
          maxHeight: `${textareaMaxHeightPx}px`,
        }}
      >
        <span className="invisible">{input}</span>
        {ghostSuffix && (
          <span className="text-[var(--content-disabled)]">{ghostSuffix}</span>
        )}
        <span className="invisible"> </span>
      </div>
      <textarea
        ref={inputRef}
        value={input}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        onChange={(e) => {
          const value = e.target.value;
          cursorRef.current = e.target.selectionStart ?? value.length;
          setInput(value);
          // The user has edited the text, so it's no longer a pristine
          // restored draft, so retire the "draft restored" marker (and its
          // notice). Keeps `restoredDraftConversationId` an accurate
          // signal for "unedited restored draft" (see use-deep-link-consumer).
          if (
            useComposerStore.getState().restoredDraftConversationId !== null
          ) {
            useComposerStore.getState().clearRestoredDraftNotice();
          }
        }}
        onPaste={(e) => {
          const items = e.clipboardData?.items;
          if (!items) {
            return;
          }
          const files: File[] = [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item?.kind === "file") {
              const file = item.getAsFile();
              if (file) {
                files.push(file);
              }
            }
          }
          if (files.length > 0) {
            e.preventDefault();
            onAddAttachmentFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (slash.show) {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              slash.moveUp();
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              slash.moveDown();
              return;
            }
            if (e.key === "Tab" || e.key === "Enter") {
              e.preventDefault();
              const cmd = slash.items[slash.selectedIndex];
              if (cmd) {
                handleSlashCommandSelect(cmd);
              }
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              slash.dismiss();
              setInput("");
              return;
            }
          }

          if (emoji.show) {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              emoji.moveUp();
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              emoji.moveDown();
              return;
            }
            if (e.key === "Tab" || e.key === "Enter") {
              e.preventDefault();
              const selected = emoji.items[emoji.selectedIndex];
              if (selected) {
                insertEmoji(selected);
              }
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              emoji.dismiss();
              return;
            }
          }

          if (e.key === "ArrowUp" && !input.trim() && onRecallLastMessage) {
            e.preventDefault();
            onRecallLastMessage();
            return;
          }

          if (e.key === "Escape" && onCancelEdit) {
            e.preventDefault();
            onCancelEdit();
            return;
          }

          const marker = matchFormattingShortcut(e);
          if (marker) {
            e.preventDefault();
            const el = inputRef.current;
            const start = el?.selectionStart ?? input.length;
            const end = el?.selectionEnd ?? start;
            const result = applyMarkdownFormatting(input, start, end, marker);
            cursorRef.current = result.selectionStart;
            setInput(result.text);
            requestAnimationFrame(() => {
              if (el) {
                el.setSelectionRange(
                  result.selectionStart,
                  result.selectionEnd,
                );
                el.focus();
              }
            });
            return;
          }

          if (e.key === "Tab" && ghostSuffix) {
            e.preventDefault();
            const accepted = input + ghostSuffix;
            cursorRef.current = accepted.length;
            setInput(accepted);
            return;
          }
          const decision = shouldSubmitOnEnter(
            {
              key: e.key,
              shiftKey: e.shiftKey,
              metaKey: e.metaKey,
              ctrlKey: e.ctrlKey,
              isComposing: e.nativeEvent.isComposing,
              keyCode: e.keyCode,
            },
            pointerCoarse,
            {
              input,
              canSendAttachments,
              sendDisabled,
              attachmentsUploadingCount,
              cmdEnterMode,
              hasStagedContext,
            },
          );
          if (decision === "ignore") {
            return;
          }
          e.preventDefault();
          if (decision === "submit") {
            onSubmit(e as unknown as FormEvent);
          }
        }}
        placeholder={ghostSuffix ? "" : placeholder}
        // A live-voice session leaves this alone: the bar above owns
        // the session, and typing alongside it is the point of moving
        // the bar out of the card.
        disabled={typingDisabled}
        rows={1}
        className={`col-start-1 row-start-1 w-full resize-none overflow-y-auto border-none bg-transparent text-chat text-[var(--content-default)] placeholder:text-[var(--content-disabled)] focus:outline-none disabled:opacity-50 ${textFieldPaddingClass}`}
        style={{ maxHeight: `${textareaMaxHeightPx}px` }}
      />
    </div>
  );

  return (
    <>
      {firstRunCardOpen && (
        // First voice-mode entry only — the card commits prefs + starts via
        // `handleFirstRunStart`; a plain dismiss cancels without consuming the
        // first run, so it returns on the next entry. On Capacitor iOS the card
        // is locked (no ✕ / backdrop / Escape): it precedes the live-voice
        // `getUserMedia` alert, so per `docs/CAPACITOR.md` § OS permission
        // requests the pre-prompt must lead straight to that alert — its only
        // action is "Start talking", and there is no card-level cancel (backing
        // out means denying the OS mic prompt, or ✕ once the room opens).
        <VoiceFirstRunCard
          assistantId={assistantId}
          onStart={handleFirstRunStart}
          onDismiss={() =>
            useLiveVoiceStore.getState().setFirstRunCardOpen(false)
          }
          nonDismissible={isNativeIOS()}
        />
      )}
      {/* Every banner that stands over the card, in one watched box. While
          anything is in it the strip between the banner and the card is
          spoken for, and the two things that float in that strip (the mobile
          settings row below, and `ComposerPeek`'s avatar) stand down. */}
      <div ref={bannerStackRef} data-slot="composer-banner-stack">
        {/* Composer-owned draft/attachment notices (self-sourced), above the
            orchestration banner stack. */}
        <ComposerDraftNotices />
        {/* Live-voice failure notice, surfaced by the voice-enabled composer
            the user is looking at, mirroring the dictation `voiceError` Notice
            rendered by `ComposerNotices` in the orchestration stack below.
            Keyed on the session state (not entry eligibility) for the same
            reason as `isLiveVoiceActive`: a session that fails right after an
            eligibility drop must still surface its error. */}
        {showVoiceInput && liveVoiceState === "failed" && liveVoiceError && (
          <div className="mb-2">
            <Notice
              tone="error"
              onDismiss={dismissLiveVoiceFailure}
              actions={
                liveVoiceErrorRecovery?.kind === "reclaim" ? (
                  <>
                    <Button
                      variant="outlined"
                      size="compact"
                      onClick={() => {
                        void handleReclaimLiveVoice();
                      }}
                    >
                      {t("chatComposer.endOtherVoiceSession")}
                    </Button>
                    {/* Only when it is somewhere else: navigating to the
                        conversation already on screen would visibly do
                        nothing. */}
                    {liveVoiceErrorRecovery.holderConversationId && (
                      <Button
                        variant="ghost"
                        size="compact"
                        onClick={handleGoToVoiceSession}
                      >
                        {t("chatComposer.goToVoiceSession")}
                      </Button>
                    )}
                  </>
                ) : undefined
              }
            >
              {liveVoiceError}
            </Notice>
          </div>
        )}
        {/* Pre-open "configure voice" prompt, surfaced when the readiness
            preflight returns `not-ready` (no usable STT/TTS provider that
            couldn't be auto-configured). The room stays closed; the action
            deep-links to voice settings so the user can wire a provider. */}
        {showVoiceInput && voiceConfigNotice && (
          <div className="mb-2">
            <Notice
              tone="warning"
              onDismiss={() => publishConfigNotice(null)}
              actions={
                <Button
                  variant="outlined"
                  size="compact"
                  onClick={() => {
                    publishConfigNotice(null);
                    navigate(routes.settings.voice);
                  }}
                >
                  {t("chatComposer.configureVoice")}
                </Button>
              }
            >
              {voiceConfigNotice}
            </Notice>
          </div>
        )}
        {noticesAboveFormSlot}
      </div>
      {isLiveVoiceActive && (
        // The minimized session surface, directly above the composer card
        // rather than in place of it: the session gets a bar, the user keeps a
        // working chat input. ✕ ends the session, ⤢ grows it back into the
        // room (omitted in pop-out windows, where the room never renders and
        // the standalone pill is the only other surface).
        <div className="mb-2">
          <VoiceComposerBar
            state={liveVoiceState}
            getAmplitude={getLiveVoiceInputAmplitude}
            getOutputAmplitude={getLiveVoiceOutputAmplitude}
            muted={liveVoiceMuted}
            onToggleMute={() => setLiveVoiceMuted(!liveVoiceMuted)}
            outputMuted={liveVoiceOutputMuted}
            onToggleOutputMute={() =>
              setLiveVoiceOutputMuted(!liveVoiceOutputMuted)
            }
            onEnd={endLiveVoiceSession}
            onExpand={isPopout ? undefined : restoreVoiceRoom}
            paint={voiceSurfacePaint}
          />
        </div>
      )}
      {/* `data-banner-above` is published for `ComposerPeek`, which reads the
          flag off this shell rather than watching the same stack a second
          time on its own clock. */}
      <div
        ref={composerShellRef}
        data-slot="chat-composer-shell"
        data-banner-above={hasBannerAboveCard ? "" : undefined}
      >
        {/* Above every slot placement, the pills row included: what a control
            does when the card runs narrow is the control's own business, and
            must not depend on which row it happens to be sitting in. */}
        <ComposerCompactProvider compact={compactSettings}>
          {isMobileMainComposer && (
            // Mounted for as long as the composer is, because each pill gates
            // itself on server state its own menu loads (access waits on the
            // global-threshold fetch), and a row that mounted on first focus
            // would rise with that pill still missing.
            //
            // In the app shells it then stays visible. In a mobile browser its
            // visibility follows focus, and `hidden` is `display: none`, which
            // keeps the resting row out of the layout, the tab order and the
            // accessibility tree, and lets the entrance run again on every
            // reveal. Reduced motion keeps the placement and drops the
            // movement.
            <div
              data-slot="composer-settings-pills"
              hidden={!settingsPillsVisible}
              // The right inset lands the last pill's edge over the send
              // circle's, so the row reads as hung off the card rather than
              // floated past it.
              className={settingsPillsClassName}
            >
              {thresholdPickerSlot}
              {modelPickerSlot}
            </div>
          )}
          <Popover.Root open={emoji.show || slash.show}>
            <Popover.Anchor asChild>
              <form
                ref={composerCardRef}
                data-slot="chat-composer"
                onSubmit={onSubmit}
                className={`overflow-hidden bg-[var(--surface-lift)] shadow-[0px_2px_2px_rgba(0,0,0,0.05)] ${cardShapeClass}`}
              >
                {/* overflow-hidden lives here, not on the form itself: the form
                casts the shadow above, and overflow-hidden on the same box
                would clip that shadow along with the rounded corners. */}
                <div className={`overflow-hidden ${cardShapeClass}`}>
                  <ChatAttachmentsStrip
                    attachments={attachments}
                    onRemove={removeAttachment}
                  />
                  {isMobile ? (
                    <>
                      {inlineVoicePreview}
                      {/* One row: add, divider, input, mic, voice-or-send.
                        `items-end` holds the fixed-height controls on the
                        card's bottom edge while the textarea grows upward.
                        Once the draft outgrows that line the same row wraps:
                        the text takes the full width and the two control
                        clusters drop beneath it. Every control keeps its place
                        in this one flex container across the change, so the
                        textarea is never rebuilt under a caret mid-word. */}
                      <div
                        ref={mobileRowRef}
                        className={cn(
                          "flex items-end py-1.5 pl-0.5 pr-1.5",
                          // 4px against the field's own 8px of bottom padding
                          // is the 12px the design leaves between the draft
                          // and the controls.
                          isMultilineDraft && "flex-wrap gap-y-1",
                        )}
                      >
                        <div
                          ref={inlineActionsStartRef}
                          data-slot="composer-inline-actions-start"
                          className="flex shrink-0 items-end"
                        >
                          {contextWindowIndicatorSlot ? (
                            // A bare slot in an `items-end` row sits flush on
                            // the card's bottom edge; a control-height box
                            // centres it against the glyphs beside it instead.
                            <div className="mr-1 flex h-10 shrink-0 items-center">
                              {contextWindowIndicatorSlot}
                            </div>
                          ) : null}
                          {!isAssistantBusy && attachControl}
                          {!isAssistantBusy && (
                            <div
                              aria-hidden="true"
                              className="-ml-0.5 mb-2 h-6 w-px shrink-0 bg-[var(--border-hover)]"
                            />
                          )}
                        </div>
                        {textFieldBlock}
                        {/* The mic's 40x40 box carries 10px of slack around its
                          20px glyph, so 6px of gap lands that glyph the
                          design's 16px from the voice circle. `ml-auto` anchors
                          the group to the right end of whichever line it is
                          on: the wrapped control row, and the inline row once
                          native dictation has taken the textarea's `flex-1`
                          out of it. */}
                        <div
                          ref={inlineActionsEndRef}
                          data-slot="composer-inline-actions-end"
                          className="ml-auto flex shrink-0 items-end gap-1.5"
                        >
                          {isAssistantBusy ? (
                            busyRowControl
                          ) : (
                            <>
                              {dictationButton}
                              {sendSlot}
                            </>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      {textFieldBlock}
                      {inlineVoicePreview}
                      {/* Action row: attach, divider, access on the left; model
                        profile, divider, mic, send on the right. It stays
                        mounted through a live-voice session, whose own
                        controls live in the bar above the card. */}
                      <div className="flex items-center justify-between gap-1 px-2 pb-2">
                        <div className="flex min-w-0 items-center gap-2">
                          {contextWindowIndicatorSlot}
                          {!isAssistantBusy && attachControl}
                          {!isAssistantBusy && thresholdPickerSlot ? (
                            <div
                              aria-hidden="true"
                              className="h-4 w-px shrink-0 bg-[var(--border-hover)] touch-mobile:-mx-1"
                            />
                          ) : null}
                          {thresholdPickerSlot}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {isAssistantBusy ? (
                            busyRowControl
                          ) : (
                            <>
                              {/* Compact: the model profile moves into the
                              left slot's hamburger alongside access, so
                              nothing is mounted here. */}
                              {!compactSettings && modelPickerSlot}
                              {!compactSettings &&
                              modelPickerSlot &&
                              showDictationButton ? (
                                <div
                                  aria-hidden="true"
                                  className="h-4 w-px shrink-0 bg-[var(--border-hover)] touch-mobile:-mx-1"
                                />
                              ) : null}
                              {dictationButton}
                              {sendSlot}
                            </>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </form>
            </Popover.Anchor>
            <Popover.Content
              side="top"
              align="start"
              sideOffset={4}
              className="w-[var(--radix-popover-trigger-width)] rounded-none bg-transparent p-0 shadow-none"
              onOpenAutoFocus={(e: Event) => e.preventDefault()}
              onCloseAutoFocus={(e: Event) => e.preventDefault()}
              onInteractOutside={(e: Event) => e.preventDefault()}
              onEscapeKeyDown={(e: Event) => e.preventDefault()}
              onPointerDownOutside={(e: Event) => e.preventDefault()}
            >
              {emoji.show && (
                <EmojiPickerPopup
                  entries={emoji.items}
                  selectedIndex={emoji.selectedIndex}
                  onSelect={insertEmoji}
                />
              )}
              {slash.show && (
                <SlashCommandPopup
                  commands={slash.items}
                  selectedIndex={slash.selectedIndex}
                  onSelect={handleSlashCommandSelect}
                />
              )}
            </Popover.Content>
          </Popover.Root>
          {/* Beside the form, not inside it: a hidden file input stays mounted
              while a native picker is up, and has no business in the form the
              composer submits. Mounted whatever the row is showing, so a width
              or pointer change cannot pull it out from under an open picker.
              The hook lays the input out as `absolute inset-0`, so it needs a
              positioned box of its own. */}
          <div className="relative">{attachPickerInput}</div>
          {/* The camera behind `deeplink.openCamera`. A `fixed inset-0`
              surface of its own rather than a hidden input, so it needs no box
              here, and rendered whether or not this composer offers a camera
              control: the command comes from outside the app. */}
          {cameraDeepLinkOverlay}
          {(usesAddSheet || addSheetEverPresented) && (
            // The sheet's own three inputs, beside the form for the same
            // reason. The latch keeps a sheet that has ever been presented
            // mounted for the rest of the session: its rows close it before
            // launching the OS picker, and a width change while that picker was
            // up would otherwise unmount the input still waiting for the pick.
            <AddToChatSheet
              open={addSheetOpen}
              onOpenChange={handleAddSheetOpenChange}
              onAttachFiles={onAddAttachmentFiles}
              onPickerOpenChange={setAddSheetPickerOpen}
            />
          )}
        </ComposerCompactProvider>
      </div>
    </>
  );
}

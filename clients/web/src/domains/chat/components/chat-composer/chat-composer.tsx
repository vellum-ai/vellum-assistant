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
} from "react";
import { flushSync } from "react-dom";

import {
    AttachFileButton,
    ChatAttachmentsStrip,
} from "@/domains/chat/components/chat-attachments/chat-attachments";
import {
    selectPathReferencePaths,
    selectUploadedIds,
    selectUploadingCount,
    useComposerStore,
} from "@/domains/chat/composer-store";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import { ComposerDraftNotices } from "@/domains/chat/components/composer-draft-notices";
import { StreamingWaveform } from "@/domains/chat/components/chat-composer/streaming-waveform";
import { LiveVoiceButton } from "@/domains/chat/components/live-voice-button";
import {
    VoiceInputButton,
    type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import { type TurnPhase, useTurnStore } from "@/domains/chat/turn-store";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useAudioAmplitude } from "@/domains/chat/voice/use-audio-amplitude";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { isPointerCoarse } from "@/utils/pointer";
import { Button, Popover } from "@vellumai/design-library";

import {
    computeGhostSuffix,
    shouldSubmitOnEnter,
} from "@/domains/chat/components/chat-composer/chat-composer-utils";
import { EMOJI_MIN_FILTER_LENGTH, EMOJI_TRIGGER_RE, type EmojiEntry, useEmojiSearch } from "@/domains/chat/components/chat-composer/emoji-catalog";
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
  onAddAttachmentFiles: (files: FileList | File[]) => void;

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
   * Whether the active assistant turn can be cancelled. Computed by the
   * parent from {@link canStopGeneration} which accounts for server-side
   * processing state (survives page refresh), external-channel streaming,
   * and the local turn phase. The composer must not derive this locally
   * because the turn store resets to idle on refresh.
   */
  canStopGenerating: boolean;

  // assistant id used by AttachFileButton's disabled guard
  assistantId: string | null;

  // Active conversation the live-voice session should attach to. Optional —
  // when absent (e.g. the empty/new-conversation state) live voice still
  // starts a fresh session for the assistant. The app-editing variant, which
  // has no voice, leaves this undefined.
  conversationId?: string | null;

  // chrome surfacing existing buttons (rendered in the form's bottom-left row)
  thresholdPickerSlot?: ReactNode;
  contextWindowIndicatorSlot?: ReactNode;

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
  canStopGenerating,
  assistantId,
  conversationId,
  thresholdPickerSlot,
  contextWindowIndicatorSlot,
  noticesAboveFormSlot,
  hasBillingBanner = false,
  textareaMaxHeightPx = 240,
  cmdEnterMode = false,
  suggestion,
  onRecallLastMessage,
  onCancelEdit,
}: ChatComposerProps) {
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
  const isVoiceActive = voicePhase === "recording" || voicePhase === "processing";
  // Holds the MediaStream opened by VoiceInputButton so we can reuse it for
  // amplitude analysis rather than opening a second getUserMedia request.
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null);
  const { amplitude } = useAudioAmplitude({
    active: voicePhase === "recording" && voiceStream !== null,
    stream: voiceStream,
  });
  const setVoiceAudioLevel = useVoiceRecordingStore.use.setAudioLevel();
  useEffect(() => {
    if (!voiceStream) return;
    setVoiceAudioLevel(amplitude);
  }, [amplitude, voiceStream, setVoiceAudioLevel]);
  const showVoiceInput =
    voiceInputRef !== undefined && onVoiceTranscript !== undefined;

  // ---- Live voice (full-duplex conversation) ----------------------------
  // Coexists with dictation: `LiveVoiceButton` self-gates on the `voice-mode`
  // flag, but the transcript surface and the mutual-exclusion wiring below
  // must also no-op when the flag is off so the composer is byte-identical for
  // users without the flag. The live-voice button only appears alongside the
  // dictation button (same `showVoiceInput` precondition + a non-null id).
  const voiceMode = useAssistantFeatureFlagStore.use.voiceMode();
  const liveVoiceEligible = voiceMode && showVoiceInput && !!assistantId;
  // Read session state via the store's per-field selectors rather than mounting
  // a second `useLiveVoice()` controller. The single controller instance lives
  // in `LiveVoiceButton` (which drives start/stop + owns the unmount-teardown
  // effect); the composer only ever *reads* the projected state, so two
  // controllers with competing teardown effects on the same store would be a
  // footgun. These atomic selectors re-render only on the fields they read.
  const liveVoiceState = useLiveVoiceStore.use.state();
  const liveVoicePartial = useLiveVoiceStore.use.partialTranscript();
  const liveVoiceFinal = useLiveVoiceStore.use.finalTranscript();
  const liveVoiceAssistant = useLiveVoiceStore.use.assistantTranscript();
  // Anything but idle/failed counts as an active session; while active the
  // dictation mic is disabled so the two capture flows never run at once.
  // `failed` is a retryable/inactive state in `useLiveVoice`/`LiveVoiceButton`,
  // so we must treat it as inactive — otherwise dictation stays disabled and
  // the (empty) transcript surface stays mounted after a failed start.
  const isLiveVoiceActive =
    liveVoiceEligible &&
    liveVoiceState !== "idle" &&
    liveVoiceState !== "failed";

  const pointerCoarse = useMemo(() => isPointerCoarse(), []);
  const isMobile = useIsMobile();
  const isNative = useIsNativePlatform();
  const isElectronHost = isElectron();

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

  // Slash and emoji popups — state is derived from the input text, not stored.
  const slash = useTextPopup({
    text: input,
    trigger: SLASH_PREFIX_RE,
    search: filteredCommands,
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
  const hideTextareaForVoice =
    isNative && showInlineVoicePreview;
  const hasStagedQuotes =
    useQuoteReplyStore.use.stagedQuotes().length > 0;
  const canSendMessageContent =
    Boolean(input.trim()) || canSendAttachments || hasStagedQuotes;

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

  return (
    <>
      {/* Composer-owned draft/attachment notices (self-sourced), above the
          orchestration banner stack. */}
      <ComposerDraftNotices />
      {noticesAboveFormSlot}
      <Popover.Root open={emoji.show || slash.show}>
        <Popover.Anchor asChild>
          <form
            onSubmit={onSubmit}
            className={`overflow-hidden bg-[var(--surface-lift)] shadow-[0px_2px_2px_rgba(0,0,0,0.05)] ${
              hasBillingBanner ? "rounded-b-[10px]" : "rounded-[10px]"
            }`}
          >
            <ChatAttachmentsStrip
              attachments={attachments}
              onRemove={removeAttachment}
            />
            {/* CSS Grid hidden-mirror technique for auto-growing textarea.
            A hidden div mirrors the textarea content in the same grid cell.
            The grid auto-sizes to max(mirror_height, textarea_intrinsic_height),
            so the textarea stretches to fit — no JS height measurement needed.
            This avoids the iOS WKWebView re-dispatch bug entirely: no DOM
            geometry mutation means no re-fired input events.
            Reference: https://css-tricks.com/the-cleanest-trick-for-autogrowing-textareas/ */}
            <div className={hideTextareaForVoice ? "hidden" : "grid"}>
              <div
                aria-hidden
                className="pointer-events-none col-start-1 row-start-1 overflow-hidden whitespace-pre-wrap break-words px-4 pt-3 pb-2 text-chat"
                style={{
                  fontFamily: "inherit",
                  letterSpacing: "inherit",
                  maxHeight: `${textareaMaxHeightPx}px`,
                }}
              >
                <span className="invisible">{input}</span>
                {ghostSuffix && (
                  <span className="text-[var(--content-disabled)]">
                    {ghostSuffix}
                  </span>
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
                  // restored draft — retire the "draft restored" marker (and its
                  // notice). Keeps `restoredDraftConversationId` an accurate
                  // signal for "unedited restored draft" (see use-deep-link-consumer).
                  if (useComposerStore.getState().restoredDraftConversationId !== null) {
                    useComposerStore.getState().clearRestoredDraftNotice();
                  }
                }}
                onPaste={(e) => {
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  const files: File[] = [];
                  for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (item?.kind === "file") {
                      const file = item.getAsFile();
                      if (file) files.push(file);
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
                      if (cmd) handleSlashCommandSelect(cmd);
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
                      if (selected) insertEmoji(selected);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      emoji.dismiss();
                      return;
                    }
                  }

                  if (
                    e.key === "ArrowUp" &&
                    !input.trim() &&
                    onRecallLastMessage
                  ) {
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
                    const result = applyMarkdownFormatting(
                      input,
                      start,
                      end,
                      marker,
                    );
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
                      hasStagedQuotes,
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
                disabled={typingDisabled}
                rows={1}
                className="col-start-1 row-start-1 w-full resize-none overflow-y-auto border-none bg-transparent px-4 pt-3 pb-2 text-chat text-[var(--content-default)] placeholder:text-[var(--content-disabled)] focus:outline-none disabled:opacity-50"
                style={{ maxHeight: `${textareaMaxHeightPx}px` }}
              />
            </div>
            {showInlineVoicePreview && (
              // Non-Electron fallback: Electron uses the shared top-center
              // dictation overlay for both focused and global recording.
              // Browser/iOS hosts keep this inline waveform because the
              // overlay bridge no-ops there.
              <div
                className={hideTextareaForVoice ? "px-2 pt-3" : "px-2"}
                aria-label={voicePhase === "processing" ? "Transcribing" : "Recording"}
                aria-live="polite"
              >
                <StreamingWaveform
                  amplitude={amplitude}
                  paused={voicePhase === "processing"}
                />
                {voicePhase === "processing" ? (
                  <p className="mt-1 truncate text-[11px] italic text-[var(--content-tertiary)]">
                    Transcribing…
                  </p>
                ) : (
                  voiceInterim && (
                    // Partial transcript ghost text — mirrors macOS composerTextField
                    // showing interim results in the input binding while speaking.
                    <p className="mt-1 truncate text-[11px] italic text-[var(--content-tertiary)]">
                      {voiceInterim}
                    </p>
                  )
                )}
              </div>
            )}
            {isLiveVoiceActive && (
              // Live-voice transcript surface — distinct from the dictation
              // interim preview above, which only exists while the dictation
              // recorder is running. Shows the user's partial/final speech and
              // the streaming assistant reply for the in-flight turn.
              <div
                className="px-4 pb-1 space-y-0.5"
                aria-label="Live voice transcript"
                aria-live="polite"
              >
                {(liveVoicePartial || liveVoiceFinal) && (
                  <p className="truncate text-[11px] text-[var(--content-secondary)]">
                    {liveVoicePartial || liveVoiceFinal}
                  </p>
                )}
                {liveVoiceAssistant && (
                  <p className="truncate text-[11px] italic text-[var(--content-tertiary)]">
                    {liveVoiceAssistant}
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center justify-between px-2 pb-2">
              <div className="flex items-center gap-1">
                {thresholdPickerSlot}
                {contextWindowIndicatorSlot}
              </div>
              <div className="flex items-center gap-1">
                {canStopGenerating ? (
                  <>
                    {/* Desktop: always show stop. Mobile: show stop only when there is no sendable content. */}
                    {(!isMobile || !canSendMessageContent) && (
                      <Button
                        variant="primary"
                        iconOnly={
                          <Square className="h-3 w-3" fill="currentColor" />
                        }
                        onClick={onStopGenerating}
                        aria-label="Stop generating"
                      />
                    )}
                    {/* Mobile: show send instead of stop when content can be queued. */}
                    {isMobile && canSendMessageContent && (
                      <Button
                        variant="primary"
                        iconOnly={
                          <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                        }
                        type="submit"
                        disabled={sendDisabled || attachmentsUploadingCount > 0}
                        title={
                          sendDisabled
                            ? "Type a message to send"
                            : attachmentsUploadingCount > 0
                              ? "Uploading attachments…"
                              : "Send message"
                        }
                        aria-label="Send message"
                      />
                    )}
                  </>
                ) : (
                  <>
                    <AttachFileButton
                      disabled={typingDisabled || !assistantId}
                      onFilesSelected={onAddAttachmentFiles}
                    />
                    {showVoiceInput && (
                      <VoiceInputButton
                        ref={voiceInputRef}
                        assistantId={assistantId}
                        // Mutual exclusion: an active live-voice session
                        // disables the dictation mic so the two capture flows
                        // never run simultaneously.
                        disabled={typingDisabled || isLiveVoiceActive}
                        onTranscript={onVoiceTranscript}
                        onInterimTranscript={onVoiceInterimTranscript}
                        onError={onVoiceError}
                        onBeforeStart={onVoiceBeforeStart}
                        onStreamReady={(stream: MediaStream | null) => {
                          voiceStreamRef.current = stream;
                          setVoiceStream(stream);
                        }}
                      />
                    )}
                    {showVoiceInput && assistantId && (
                      // Self-gates on the `voice-mode` flag (renders null when
                      // off — no layout shift). The composer's busy/disabled
                      // signal only gates the START path; an active session
                      // stays stoppable even while the composer is otherwise
                      // busy (see LiveVoiceButton).
                      //
                      // Mutual exclusion (reverse direction): while dictation is
                      // active (`isVoiceActive`) we disable live voice so it
                      // can't START a second mic/voice session alongside the
                      // recorder. `LiveVoiceButton` only applies external
                      // `disabled` to its START path, so an in-flight live-voice
                      // session is never trapped by this.
                      <LiveVoiceButton
                        assistantId={assistantId}
                        conversationId={conversationId ?? undefined}
                        disabled={typingDisabled || isVoiceActive}
                      />
                    )}
                    {/* macOS parity: the send button is hidden during recording
                    and while transcription is being processed. Only the voice
                    button (mic / stop / spinner) is shown. */}
                    {!isVoiceActive && (
                      <Button
                        variant="primary"
                        iconOnly={
                          <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                        }
                        type="submit"
                        disabled={
                          sendDisabled ||
                          attachmentsUploadingCount > 0 ||
                          !canSendMessageContent
                        }
                        title={
                          sendDisabled || !canSendMessageContent
                            ? "Type a message to send"
                            : attachmentsUploadingCount > 0
                              ? "Uploading attachments…"
                              : "Send message"
                        }
                        aria-label="Send message"
                      />
                    )}
                  </>
                )}
              </div>
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
    </>
  );
}

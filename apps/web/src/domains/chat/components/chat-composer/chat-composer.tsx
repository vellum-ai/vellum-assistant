import { ArrowUp, Square } from "lucide-react";
import {
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import {
  AttachFileButton,
  ChatAttachmentsStrip,
} from "@/domains/chat/components/chat-attachments/chat-attachments.js";
import type { ChatAttachment } from "@/domains/chat/components/chat-attachments/use-chat-attachments.js";
import { Button, Popover } from "@vellum/design-library";
import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button.js";
import { type TurnPhase, useTurnStore } from "@/domains/messaging/turn-store.js";
import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { isPointerCoarse } from "@/utils/pointer.js";
import { useAudioAmplitude } from "@/domains/voice/use-audio-amplitude.js";
import { useVoiceRecordingStore } from "@/domains/voice/voice-recording-store.js";
import { StreamingWaveform } from "@/domains/chat/components/chat-composer/streaming-waveform.js";

import { EMOJI_MIN_FILTER_LENGTH, EMOJI_TRIGGER_RE, searchEmoji, type EmojiEntry } from "@/domains/chat/components/chat-composer/emoji-catalog.js";
import { EmojiPickerPopup } from "@/domains/chat/components/chat-composer/emoji-picker-popup.js";
import { SlashCommandPopup } from "@/domains/chat/components/chat-composer/slash-command-popup.js";
import {
  applyMarkdownFormatting,
  matchFormattingShortcut,
} from "@/domains/chat/components/chat-composer/markdown-formatting.js";
import {
  SLASH_PREFIX_RE,
  filteredCommands,
  type SlashCommand,
  selectedInputText,
} from "@/domains/chat/components/chat-composer/slash-command-catalog.js";
import { useTextPopup } from "@/domains/chat/components/chat-composer/use-text-popup.js";

// ---------------------------------------------------------------------------
// Keyboard policy
// ---------------------------------------------------------------------------

interface ComposerKeyDownPolicy {
  input: string;
  canSendAttachments: boolean;
  sendDisabled: boolean;
  attachmentsUploadingCount: number;
  cmdEnterMode: boolean;
}

/**
 * Pure-logic mirror of the textarea `onKeyDown` policy. Returns whether the
 * Enter keypress should submit the form. Exported for unit tests because the
 * web workspace lacks a DOM-event testing harness — the production handler
 * delegates to this helper to keep behavior in lockstep.
 *
 * Returns:
 *   - `"ignore"`: the event is not Enter-without-shift, IME composition, or
 *     pointer is coarse — let the browser handle the keypress.
 *   - `"submit"`: caller should `preventDefault()` and invoke `onSubmit`.
 *   - `"prevent"`: caller should `preventDefault()` but NOT submit (sendDisabled,
 *     uploading attachments, or no content).
 */
export function shouldSubmitOnEnter(
  event: {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
    keyCode: number;
  },
  isPointerCoarse: boolean,
  policy: ComposerKeyDownPolicy,
): "ignore" | "submit" | "prevent" {
  if (event.key !== "Enter" || event.shiftKey) {
    return "ignore";
  }
  // Don't intercept IME composition (CJK input confirmation)
  if (event.isComposing || event.keyCode === 229) {
    return "ignore";
  }
  // Coarse primary pointer = phone/tablet; fine = mouse/trackpad.
  // Touch-screen laptops (Surface, etc.) report "fine" and keep desktop
  // Enter-to-send behavior.
  if (isPointerCoarse) {
    return "ignore";
  }
  // Cmd+Enter mode: only Cmd+Enter (Mac) or Ctrl+Enter (Win/Linux) submits;
  // bare Enter inserts a newline.
  if (policy.cmdEnterMode) {
    if (!event.metaKey && !event.ctrlKey) return "ignore";
  }
  const hasContent = policy.input.trim() || policy.canSendAttachments;
  if (
    hasContent &&
    !policy.sendDisabled &&
    policy.attachmentsUploadingCount === 0
  ) {
    return "submit";
  }
  return "prevent";
}

// ---------------------------------------------------------------------------
// Ghost-suggestion overlay policy
// ---------------------------------------------------------------------------

interface GhostSuffixPolicy {
  pointerCoarse: boolean;
  suggestion: string | null;
  input: string;
  hasAttachments: boolean;
}

/**
 * Returns the visible suffix of an autocomplete suggestion to render as
 * ghost text behind the textarea, or `null` to render no ghost.
 *
 * Suppressed when the primary pointer is coarse (touch devices): the only
 * acceptance gesture is `Tab`, which is not present on iOS/Android soft
 * keyboards, so rendering the overlay there is purely visual noise — and
 * because the underlying textarea is `rows={1}`, multi-line ghost text
 * gets clipped on narrow viewports.
 *
 * Exported as a pure helper so the policy can be unit-tested without a
 * DOM — the web workspace runs tests under bun without jsdom.
 */
export function computeGhostSuffix(policy: GhostSuffixPolicy): string | null {
  if (policy.pointerCoarse) return null;
  if (!policy.suggestion || policy.hasAttachments) return null;
  if (policy.suggestion.startsWith(policy.input)) {
    return policy.suggestion.slice(policy.input.length) || null;
  }
  if (!policy.input) return policy.suggestion;
  return null;
}

/**
 * Controlled composer used at the bottom of the chat (main variant) and inside
 * the app-editing split layout. The two call sites previously inlined the
 * composer JSX; this component is the consolidated version.
 *
 * The optional slots/voice props exist because the app-editing variant does
 * NOT render a voice button, threshold picker, context-window indicator, or
 * the notice banners above the form — only the main variant does. Passing
 * those as `undefined` keeps the app-editing layout byte-identical.
 */
export interface ChatComposerProps {
  // text + form
  input: string;
  /**
   * Accepts both a plain setter (`setInput("foo")`) and the React-state
   * updater form (`setInput((current) => …)`). The voice transcript handler
   * relies on the updater form; the rest of the composer only writes plain
   * strings.
   */
  setInput: Dispatch<SetStateAction<string>>;
  placeholder?: string;
  onSubmit: (event: FormEvent) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  typingDisabled: boolean;
  sendDisabled: boolean;
  attachmentsUploadingCount: number;
  canSendAttachments: boolean;

  // attachments
  chatAttachments: ChatAttachment[];
  onAddAttachmentFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;

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

  // assistant id used by AttachFileButton's disabled guard
  assistantId: string | null;

  /**
   * Whether the currently-active inference model accepts image input.
   * When `false`, the AttachFileButton is disabled so users can't pick a
   * file that the provider would reject downstream (MiniMax, Fireworks
   * Kimi, several OpenRouter models, etc.). Sourced at runtime from the
   * daemon config API — defaults to `true` (fail-open) when the daemon
   * hasn't surfaced the flag yet.
   */
  modelSupportsVision?: boolean;

  // chrome surfacing existing buttons (rendered in the form's bottom-left row)
  thresholdPickerSlot?: ReactNode;
  contextWindowIndicatorSlot?: ReactNode;

  // Slot rendered above the form (between the max-width wrapper and the form).
  // The main variant uses this for attachment-error / voice-error / disk-pressure
  // notices and the live voice-interim preview. The app-editing variant omits it.
  noticesAboveFormSlot?: ReactNode;

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
}

export function ChatComposer({
  input,
  setInput,
  placeholder = "What would you like to do?",
  onSubmit,
  inputRef,
  typingDisabled,
  sendDisabled,
  attachmentsUploadingCount,
  canSendAttachments,
  chatAttachments,
  onAddAttachmentFiles,
  onRemoveAttachment,
  voiceInputRef,
  onVoiceTranscript,
  onVoiceInterimTranscript,
  voiceInterim,
  onVoiceError,
  onVoiceBeforeStart,
  onStopGenerating,
  assistantId,
  thresholdPickerSlot,
  contextWindowIndicatorSlot,
  noticesAboveFormSlot,
  textareaMaxHeightPx = 240,
  cmdEnterMode = false,
  suggestion,
  modelSupportsVision = true,
}: ChatComposerProps) {
  const voicePhase = useVoiceRecordingStore.use.phase();
  const isVoiceActive = voicePhase === "recording" || voicePhase === "processing";
  // Holds the MediaStream opened by VoiceInputButton so we can reuse it for
  // amplitude analysis rather than opening a second getUserMedia request.
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null);
  const { amplitude } = useAudioAmplitude({
    active: voicePhase === "recording",
    stream: voiceStream,
  });
  const showVoiceInput =
    voiceInputRef !== undefined && onVoiceTranscript !== undefined;
  const pointerCoarse = useMemo(() => isPointerCoarse(), []);
  const isMobile = useIsMobile();

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

  const textBeforeCursor = input.slice(0, cursorRef.current);
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
  const isGenerating =
    phase === "queued" || phase === "thinking" || phase === "streaming";

  const ghostSuffix = useMemo(
    () =>
      computeGhostSuffix({
        pointerCoarse,
        suggestion: suggestion ?? null,
        input,
        hasAttachments: chatAttachments.length > 0,
      }),
    [pointerCoarse, suggestion, input, chatAttachments],
  );

  return (
    <>
      {noticesAboveFormSlot}
      <Popover.Root open={emoji.show || slash.show}>
        <Popover.Anchor asChild>
          <form
            onSubmit={onSubmit}
            className="overflow-hidden rounded-[10px] bg-[var(--surface-lift)] shadow-[0px_2px_2px_rgba(0,0,0,0.05)]"
          >
            <ChatAttachmentsStrip
              attachments={chatAttachments}
              onRemove={onRemoveAttachment}
            />
            {/* CSS Grid hidden-mirror technique for auto-growing textarea.
            A hidden div mirrors the textarea content in the same grid cell.
            The grid auto-sizes to max(mirror_height, textarea_intrinsic_height),
            so the textarea stretches to fit — no JS height measurement needed.
            This avoids the iOS WKWebView re-dispatch bug entirely: no DOM
            geometry mutation means no re-fired input events.
            Reference: https://css-tricks.com/the-cleanest-trick-for-autogrowing-textareas/ */}
            <div className="grid">
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
                    if (e.key === "Enter") {
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
            {isVoiceActive && !isGenerating && (
              // macOS parity: full-width scrolling waveform between textarea and
              // action bar. Mirrors VStreamingWaveform(.scrolling) in ComposerView.
              // Stays mounted through the `processing` phase with `paused` set so
              // the trailing recorded waveform freezes and dims while STT and
              // dictation cleanup are in flight — the visual signal that the
              // recording was captured and the transcript is on its way.
              <div
                className="px-2"
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
            <div className="flex items-center justify-between px-2 pb-2">
              <div className="flex items-center gap-1">
                {thresholdPickerSlot}
                {contextWindowIndicatorSlot}
              </div>
              <div className="flex items-center gap-1">
                {isGenerating ? (
                  <>
                    {/* Desktop: always show stop. Mobile: show stop only when user has no input. */}
                    {(!isMobile || (!input.trim() && !canSendAttachments)) && (
                      <Button
                        variant="primary"
                        iconOnly={
                          <Square className="h-3 w-3" fill="currentColor" />
                        }
                        onClick={onStopGenerating}
                        aria-label="Stop generating"
                      />
                    )}
                    {/* Mobile: show send instead of stop when user has typed input (for message queueing). */}
                    {isMobile && (input.trim() || canSendAttachments) && (
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
                      disabled={
                        typingDisabled || !assistantId || !modelSupportsVision
                      }
                      onFilesSelected={onAddAttachmentFiles}
                      title={
                        !modelSupportsVision
                          ? "The current model doesn't support image input"
                          : undefined
                      }
                    />
                    {showVoiceInput && (
                      <VoiceInputButton
                        ref={voiceInputRef}
                        assistantId={assistantId}
                        disabled={typingDisabled}
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
                          (!input.trim() && !canSendAttachments)
                        }
                        title={
                          sendDisabled || (!input.trim() && !canSendAttachments)
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

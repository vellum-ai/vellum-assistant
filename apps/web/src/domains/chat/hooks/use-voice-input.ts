
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";

import {
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import {
  shouldShowMicPrimer,
} from "@/domains/chat/components/mic-permission-primer";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { postDictation } from "@/domains/chat/voice/dictation-api";
import { usePushToTalk } from "@/domains/chat/voice/use-push-to-talk";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { isPointerCoarse } from "@/utils/pointer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseVoiceInputOptions {
  /** Current assistant ID — required for dictation cleanup via the daemon. */
  assistantId: string | null;
  /** Ref to the composer textarea for cursor-position reads and resize. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** State setter for the composer input value (React useState dispatch). */
  setInput: Dispatch<SetStateAction<string>>;
}

export interface UseVoiceInputReturn {
  /** Imperative handle ref passed to `VoiceInputButton`. */
  voiceInputRef: RefObject<VoiceInputButtonHandle | null>;
  /** Interim (partial) transcript shown while recording is in progress. */
  voiceInterim: string;
  /** Current voice error code, or null if no error. */
  voiceError: string | null;
  /** Clear the current voice error. */
  clearVoiceError: () => void;
  /** Set a specific voice error code (or null to clear). */
  setVoiceError: (code: string | null) => void;
  /** Whether the mic-permission primer dialog is open. */
  showPrimer: boolean;
  /**
   * Guard called before recording starts. On native iOS, returns true
   * immediately (OS mic alert handles the prompt). On web, shows the
   * primer dialog if the user hasn't seen it yet.
   */
  handleVoiceBeforeStart: () => boolean | Promise<boolean>;
  /**
   * Called when `VoiceInputButton` delivers a final transcript.
   * Runs dictation cleanup via the daemon, then splices the cleaned
   * text into the composer at the cursor position captured at recording
   * start.
   */
  handleVoiceTranscript: (rawText: string) => Promise<void>;

  /** Set interim transcript (passed to `VoiceInputButton.onInterimTranscript`). */
  setVoiceInterim: (text: string) => void;
  /** Continue from the mic-permission primer dialog. */
  handlePrimerContinue: () => void;
  /** Cancel the mic-permission primer dialog. */
  handlePrimerCancel: () => void;
  /**
   * Attempt to re-request microphone access after a permission error.
   * Checks the Permissions API first; if permanently denied, sets
   * `not-allowed-permanent`. Otherwise calls `getUserMedia` to re-prompt.
   */
  handleRetryMicPermission: () => Promise<void>;
}

/**
 * Encapsulates all voice-input state and callbacks for the chat composer.
 *
 * Manages:
 * - Voice interim/error state
 * - Mic-permission primer dialog
 * - Push-to-talk keyboard shortcut integration
 * - Dictation transcript processing (daemon cleanup + cursor-aware splicing)
 * - Recording lifecycle callbacks
 *
 * Framework-agnostic: no Next.js imports. Pure React hooks + browser APIs.
 *
 * @see https://react.dev/learn/reusing-logic-with-custom-hooks
 */
export function useVoiceInput({
  assistantId,
  inputRef,
  setInput,
}: UseVoiceInputOptions): UseVoiceInputReturn {
  const [voiceInterim, setVoiceInterim] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceInputRef = useRef<VoiceInputButtonHandle | null>(null);
  // Cursor position captured at the moment recording starts so that the final
  // transcript is spliced at the right point rather than always appended.
  // Mirrors macOS DictationClient inserting at the active text-field cursor.
  const voiceCursorPosRef = useRef<number | null>(null);
  const [showPrimer, setShowPrimer] = useState(false);
  const primerResolveRef = useRef<((v: boolean) => void) | null>(null);
  const isNative = useIsNativePlatform();

  // Push-to-talk is a hardware-keyboard-only affordance: the activator is a
  // configurable modifier-key hold (e.g. Right-Option) that touch soft
  // keyboards cannot produce.
  usePushToTalk(voiceInputRef, { enabled: !isPointerCoarse() });

  const clearVoiceError = useCallback(() => {
    setVoiceError(null);
  }, []);

  const handleVoiceBeforeStart = useCallback((): boolean | Promise<boolean> => {
    // On Capacitor iOS the OS mic alert (backed by NSMicrophoneUsageDescription)
    // must fire directly — any pre-prompt UI with a dismiss affordance violates
    // Apple HIG / App Store Guideline 5.1.1(iv).
    // https://developer.apple.com/design/human-interface-guidelines/requesting-permission
    if (isNative) return true;
    if (shouldShowMicPrimer()) {
      setShowPrimer(true);
      return new Promise<boolean>((resolve) => {
        primerResolveRef.current = resolve;
      });
    }
    return true;
  }, [isNative]);

  const handleVoiceTranscript = useCallback(
    async (rawText: string): Promise<void> => {
      // Capture cursor position synchronously before any async work — a
      // concurrent recording session could overwrite voiceCursorPosRef
      // during the await.
      const capturedPos = voiceCursorPosRef.current;
      voiceCursorPosRef.current = null;

      // --- Daemon cleanup (macOS parity: transforming phase) ----
      let insertText = rawText;
      const dictationResult = assistantId
        ? await postDictation(rawText, assistantId, {
            cursorInTextField: true,
          })
        : null;
      if (dictationResult?.mode === "dictation" && dictationResult.text) {
        insertText = dictationResult.text;
      }

      setInput((current: string) => {
        const insertAt = capturedPos ?? current.length;
        const pos = Math.min(insertAt, current.length);
        const before = current.slice(0, pos);
        const after = current.slice(pos);
        const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
        const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
        return `${before}${needsLeadingSpace ? " " : ""}${insertText}${needsTrailingSpace ? " " : ""}${after}`;
      });

      inputRef.current?.focus();
    },
    [assistantId, inputRef, setInput],
  );

  const isRecording = useVoiceRecordingStore.use.phase() === "recording";
  useEffect(() => {
    if (isRecording) {
      voiceCursorPosRef.current = inputRef.current?.selectionStart ?? null;
    } else {
      setVoiceInterim("");
    }
  }, [isRecording, inputRef]);

  const handlePrimerContinue = useCallback(() => {
    setShowPrimer(false);
    primerResolveRef.current?.(true);
    primerResolveRef.current = null;
  }, []);

  const handlePrimerCancel = useCallback(() => {
    setShowPrimer(false);
    primerResolveRef.current?.(false);
    primerResolveRef.current = null;
  }, []);

  const handleRetryMicPermission = useCallback(async () => {
    try {
      // Check permission state via Permissions API when available.
      // If the user permanently denied access, skip getUserMedia
      // (it won't re-prompt) and show site-settings guidance.
      const status = await navigator.permissions
        ?.query({ name: "microphone" as PermissionName })
        .catch(() => null);
      if (status?.state === "denied") {
        setVoiceError("not-allowed-permanent");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setVoiceError(null);
    } catch (err) {
      // Map DOMException names to the error codes formatVoiceError
      // already handles. Only NotAllowedError means a permanent
      // permission block — everything else is a transient/device issue.
      if (err instanceof DOMException) {
        switch (err.name) {
          case "NotAllowedError":
            setVoiceError("not-allowed-permanent");
            break;
          case "NotReadableError":
          case "NotFoundError":
            setVoiceError("audio-capture");
            break;
          case "AbortError":
            setVoiceError("aborted");
            break;
          default:
            setVoiceError(err.name);
        }
      } else {
        setVoiceError("unknown");
      }
    }
  }, []);

  return {
    voiceInputRef,
    voiceInterim,
    voiceError,
    clearVoiceError,
    setVoiceError,
    showPrimer,
    handleVoiceBeforeStart,
    handleVoiceTranscript,
    setVoiceInterim,
    handlePrimerContinue,
    handlePrimerCancel,
    handleRetryMicPermission,
  };
}

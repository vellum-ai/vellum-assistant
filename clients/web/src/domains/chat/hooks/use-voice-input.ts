
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerStore } from "@/domains/chat/composer-store";
import {
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import {
  shouldShowMicPrimer,
} from "@/domains/chat/components/mic-permission-primer";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { postDictation } from "@/domains/chat/voice/dictation-api";
import { registerPushToTalkTarget } from "@/domains/chat/voice/push-to-talk-target";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import {
  insertTextIntoFrontApp,
  openTextInsertionSettings,
} from "@/runtime/text-insertion";
import {
  openSystemPermissionSettings,
  requestSystemPermission,
  supportsSystemPermissions,
} from "@/runtime/system-permissions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseVoiceInputOptions {
  /** Current assistant ID — required for dictation cleanup via the assistant. */
  assistantId: string | null;
  /** Ref to the composer textarea for cursor-position reads and resize. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
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
  /** Open macOS Automation settings for external-app dictation paste. */
  handleOpenTextInsertionSettings: () => Promise<void>;
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
   * Runs dictation cleanup via the assistant, then inserts into the
   * focused front app when Vellum is backgrounded, or the composer when
   * Vellum is focused.
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
  /**
   * Opens the OS microphone privacy pane (System Settings → Privacy &
   * Security → Microphone on macOS) for recovering from a recorded TCC
   * denial, which the OS never re-prompts for. `undefined` when no
   * settings deep-link is available (plain browser), so callers can hide
   * the affordance entirely.
   */
  handleOpenMicSettings: (() => Promise<void>) | undefined;
}

/**
 * Encapsulates all voice-input state and callbacks for the chat composer.
 *
 * Manages:
 * - Voice interim/error state
 * - Mic-permission primer dialog
 * - Voice-target registration for the app-level push-to-talk bridge
 * - Dictation transcript processing for composer or front-app insertion
 * - Recording lifecycle callbacks
 *
 * Framework-agnostic: no Next.js imports. Pure React hooks + browser APIs.
 *
 * @see https://react.dev/learn/reusing-logic-with-custom-hooks
 */
export function useVoiceInput({
  assistantId,
  inputRef,
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

  useEffect(() => {
    return registerPushToTalkTarget({
      start: () => voiceInputRef.current?.start(),
      stop: () => voiceInputRef.current?.stop(),
    });
  }, []);

  const clearVoiceError = useCallback(() => {
    setVoiceError(null);
  }, []);

  const handleOpenTextInsertionSettings = useCallback(
    () => openTextInsertionSettings(),
    [],
  );

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

      let insertText = rawText;
      const dictationResult = assistantId
        ? await postDictation(rawText, assistantId, {
            cursorInTextField: true,
          })
        : null;
      if (dictationResult?.mode === "dictation" && dictationResult.text) {
        insertText = dictationResult.text;
      }
      const frontAppInsertion = await insertTextIntoFrontApp(insertText);
      if (frontAppInsertion.status === "inserted") {
        return;
      }
      if (frontAppInsertion.status === "automation-denied") {
        setVoiceError("dictation-automation-denied");
        useVoiceRecordingStore
          .getState()
          .flagDictationInsertionError("dictation-automation-denied");
      } else if (frontAppInsertion.status === "blocked") {
        setVoiceError("dictation-paste-blocked");
        useVoiceRecordingStore
          .getState()
          .flagDictationInsertionError("dictation-paste-blocked");
      }

      // Imperative write — voice transcripts can land while the composer is
      // unfocused (front-app dictation), so we go through the store rather than
      // a subscribed setter (per docs/STATE_MANAGEMENT.md: getState in callbacks).
      useComposerStore.getState().setInput((current: string) => {
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
    [assistantId, inputRef],
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
    if (supportsSystemPermissions()) {
      const item = await requestSystemPermission("microphone");
      if (item?.status === "granted") {
        setVoiceError(null);
      } else if (item?.status === "denied") {
        setVoiceError("not-allowed-permanent");
      }
      return;
    }

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

  const handleOpenMicSettings = useMemo(
    () =>
      supportsSystemPermissions()
        ? async () => {
            await openSystemPermissionSettings("microphone");
          }
        : undefined,
    [],
  );

  return {
    voiceInputRef,
    voiceInterim,
    voiceError,
    clearVoiceError,
    setVoiceError,
    handleOpenTextInsertionSettings,
    showPrimer,
    handleVoiceBeforeStart,
    handleVoiceTranscript,
    setVoiceInterim,
    handlePrimerContinue,
    handlePrimerCancel,
    handleRetryMicPermission,
    handleOpenMicSettings,
  };
}

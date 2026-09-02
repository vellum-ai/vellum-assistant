import { useCallback, useEffect, useRef, useState } from "react";

import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useDictationOverlaySync } from "@/domains/chat/hooks/use-dictation-overlay-sync";
import { formatVoiceError } from "@/domains/chat/utils/chat";
import { postDictation } from "@/domains/chat/voice/dictation-api";
import { getPushToTalkTarget } from "@/domains/chat/voice/push-to-talk-target";
import { supportsKeyboardActivation } from "@/domains/chat/voice/keyboard-activation-host";
import { useAudioAmplitude } from "@/domains/chat/voice/use-audio-amplitude";
import { useHoldToDictate } from "@/domains/chat/voice/use-hold-to-dictate";
import {
  markHoldDictation,
  useHoldToDictateEnabled,
} from "@/utils/hold-to-dictate";
import { useVoiceModeHotkey } from "@/domains/chat/voice/use-voice-mode-hotkey";
import { mintVoiceDraftConversation } from "@/domains/chat/voice/voice-draft-conversation";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { subscribeToDictationOverlayStop } from "@/runtime/dictation-overlay";
import { insertTextIntoFrontApp } from "@/runtime/text-insertion";
import { useConversationStore } from "@/stores/conversation-store";
import { toast } from "@vellumai/design-library/components/toast";

interface GlobalPushToTalkBridgeProps {
  assistantId: string | null;
}

/**
 * How long a hold gives the cleanup pass before inserting the words as heard.
 *
 * The route's own timeout, so the pass gets every chance to answer while its
 * cost is being measured. The log line below carries what each hold paid.
 */
const CLEANUP_DEADLINE_MS = 5000;

function appendTranscript(current: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return current;
  }
  const needsLeadingSpace = current.length > 0 && !/\s$/.test(current);
  return `${current}${needsLeadingSpace ? " " : ""}${trimmed}`;
}

/**
 * The conversation this transcript lands in: whatever is selected, and a fresh
 * draft only when nothing is. Dictation is text the user is composing, so it
 * belongs in the chat they are in; minting is the fallback for a press made
 * with no conversation selected at all.
 */
function ensureConversationKey(): string {
  return (
    useConversationStore.getState().activeConversationId ??
    mintVoiceDraftConversation()
  );
}

function showVoiceErrorToast(code: string): void {
  toast.error(formatVoiceError(code), { id: `voice-error:${code}` });
}

export function GlobalPushToTalkBridge({
  assistantId,
}: GlobalPushToTalkBridgeProps) {
  const fallbackVoiceInputRef = useRef<VoiceInputButtonHandle | null>(null);
  const voicePhase = useVoiceRecordingStore.use.phase();
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null);
  const { amplitude } = useAudioAmplitude({
    active: voicePhase === "recording" && voiceStream !== null,
    stream: voiceStream,
  });
  const setVoiceAudioLevel = useVoiceRecordingStore.use.setAudioLevel();
  const holdToDictateEnabled = useHoldToDictateEnabled();

  useEffect(() => {
    if (!voiceStream) {
      return;
    }
    setVoiceAudioLevel(amplitude);
  }, [amplitude, voiceStream, setVoiceAudioLevel]);

  // Single per-window publisher for the Electron dictation overlay. Lives
  // here — not in `useVoiceInput` — because this bridge is always mounted
  // (RootLayout) while the chat composer only exists on chat routes; the
  // overlay must mirror dictation hosted by either VoiceInputButton
  // instance. Reads everything from the shared recording store.
  // While the hold is bound, the companion surface carries the status instead:
  // one surface saying a microphone is open rather than a panel and a pill
  // saying it separately.
  useDictationOverlaySync({ suppressed: holdToDictateEnabled });

  /**
   * The recorder a held key drives, which is always this bridge's own.
   *
   * Never {@link resolveTarget}. That answers with whatever most recently
   * claimed dictation, and on a chat route that is the composer's microphone,
   * whose transcript is spliced into the composer and sent as a turn. A hold
   * is aimed at a cursor in another application: its words belong there, and
   * routing them into a conversation instead both loses them and spends a turn
   * the user did not ask for.
   *
   * The composer's own microphone is unaffected; this only decides where the
   * keys go.
   */
  const holdTarget = useCallback(
    () => (assistantId ? fallbackVoiceInputRef.current : null),
    [assistantId],
  );

  const resolveTarget = useCallback(
    () =>
      getPushToTalkTarget() ??
      (assistantId ? fallbackVoiceInputRef.current : null),
    [assistantId],
  );

  useEffect(() => {
    return subscribeToDictationOverlayStop(() => {
      if (useVoiceRecordingStore.getState().phase !== "recording") {
        return;
      }
      resolveTarget()?.stop();
    });
  }, [resolveTarget]);

  // The voice mode shortcut lives here rather than in the chat layout because
  // this bridge is mounted app-wide: voice is reachable from any route, the
  // same way dictation is.
  useVoiceModeHotkey({ enabled: supportsKeyboardActivation() });

  // Hold to dictate, from whatever app the user is in. The same target the
  // overlay's stop button drives, so a hold and a press are the same dictation
  // and land the same way: through `handleTranscript` below, which cleans the
  // transcript up and drops it at the cursor.
  useHoldToDictate({
    enabled: holdToDictateEnabled,
    onHoldStart: () => {
      if (useVoiceRecordingStore.getState().phase === "recording") {
        return;
      }
      // Read by the recording session as it starts, which decides there
      // whether the local transcript is the authority.
      markHoldDictation(true);
      holdTarget()?.start();
    },
    onHoldEnd: () => {
      markHoldDictation(false);
      if (useVoiceRecordingStore.getState().phase !== "recording") {
        return;
      }
      holdTarget()?.stop();
    },
  });

  const handleTranscript = useCallback(
    async (rawText: string): Promise<void> => {
      let insertText = rawText;
      // The cleanup pass: one model call that punctuates, drops the fillers,
      // adapts the tone to the application in front and applies the user's
      // own style. It is what turns "grocery list, onions, tomatoes" into a
      // list, and the only leg of this that can. A hold takes it too, now that
      // nothing else on its path is worth waiting for; what it costs is
      // measured rather than assumed. Character counts and timings only.
      //
      // Raced against a deadline rather than awaited, so a daemon that is not
      // answering costs the hold the deadline and no more. Past it the raw
      // words go down and the late answer is dropped.
      const cleanupStartedAt = Date.now();
      const cleanupAbort = new AbortController();
      const dictationResult = assistantId
        ? await Promise.race([
            postDictation(
              rawText,
              assistantId,
              {
                cursorInTextField: true,
              },
              cleanupAbort.signal,
            ),
            new Promise<null>((resolve) => {
              setTimeout(() => {
                cleanupAbort.abort();
                resolve(null);
              }, CLEANUP_DEADLINE_MS);
            }),
          ])
        : null;
      if (dictationResult?.mode === "dictation" && dictationResult.text) {
        insertText = dictationResult.text;
      }
      console.info(
        `dictation: cleanup ${dictationResult ? dictationResult.mode : "skipped"} inChars=${rawText.length} outChars=${insertText.length} ms=${Date.now() - cleanupStartedAt}`,
      );
      const insertStartedAt = Date.now();
      const frontAppInsertion = await insertTextIntoFrontApp(insertText);
      console.info(
        `dictation: inserted chars=${insertText.length} status=${frontAppInsertion.status} ms=${Date.now() - insertStartedAt}`,
      );
      if (frontAppInsertion.status === "inserted") {
        return;
      }

      if (frontAppInsertion.status === "automation-denied") {
        showVoiceErrorToast("dictation-automation-denied");
        useVoiceRecordingStore
          .getState()
          .flagDictationInsertionError("dictation-automation-denied");
      } else if (frontAppInsertion.status === "blocked") {
        showVoiceErrorToast("dictation-paste-blocked");
        useVoiceRecordingStore
          .getState()
          .flagDictationInsertionError("dictation-paste-blocked");
      }

      if (assistantId) {
        useComposerStore
          .getState()
          .loadAssistantDrafts(
            assistantId,
            useConversationStore.getState().activeConversationId,
          );
      }

      const conversationKey = ensureConversationKey();
      const composer = useComposerStore.getState();
      const nextInput = appendTranscript(composer.input, insertText);
      composer.setInput(nextInput);
      composer.saveDraft(conversationKey, nextInput);
    },
    [assistantId],
  );

  const handleError = useCallback((code: string | null) => {
    if (code) {
      showVoiceErrorToast(code);
    }
  }, []);

  const allowVoiceStart = useCallback(() => true, []);

  return (
    <VoiceInputButton
      ref={fallbackVoiceInputRef}
      assistantId={assistantId}
      onTranscript={handleTranscript}
      onError={handleError}
      onStreamReady={setVoiceStream}
      onBeforeStart={allowVoiceStart}
      renderButton={false}
    />
  );
}

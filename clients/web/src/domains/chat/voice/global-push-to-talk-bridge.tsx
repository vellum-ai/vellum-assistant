import { useCallback, useEffect, useRef, useState } from "react";

import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useDictationOverlaySync } from "@/domains/chat/hooks/use-dictation-overlay-sync";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { formatVoiceError } from "@/domains/chat/utils/chat";
import { postDictation } from "@/domains/chat/voice/dictation-api";
import { getPushToTalkTarget } from "@/domains/chat/voice/push-to-talk-target";
import { shouldEnablePushToTalk } from "@/domains/chat/voice/push-to-talk-host";
import { useNativePushToTalkRegistration } from "@/domains/chat/voice/use-native-push-to-talk-registration";
import { useAudioAmplitude } from "@/domains/chat/voice/use-audio-amplitude";
import { usePushToTalk } from "@/domains/chat/voice/use-push-to-talk";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { subscribeToDictationOverlayStop } from "@/runtime/dictation-overlay";
import { insertTextIntoFrontApp } from "@/runtime/text-insertion";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { toast } from "@vellumai/design-library/components/toast";

interface GlobalPushToTalkBridgeProps {
  assistantId: string | null;
}

function appendTranscript(current: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return current;
  const needsLeadingSpace = current.length > 0 && !/\s$/.test(current);
  return `${current}${needsLeadingSpace ? " " : ""}${trimmed}`;
}

function ensureConversationKey(): string {
  const existing = useConversationStore.getState().activeConversationId;
  if (existing) return existing;

  const draftId = createDraftConversationId();
  useConversationStore.getState().setActiveConversationId(draftId);
  useViewerStore.getState().setMainView("chat");
  return draftId;
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

  useEffect(() => {
    if (!voiceStream) return;
    setVoiceAudioLevel(amplitude);
  }, [amplitude, voiceStream, setVoiceAudioLevel]);

  useNativePushToTalkRegistration();

  // Single per-window publisher for the Electron dictation overlay. Lives
  // here — not in `useVoiceInput` — because this bridge is always mounted
  // (RootLayout) while the chat composer only exists on chat routes; the
  // overlay must mirror dictation hosted by either VoiceInputButton
  // instance. Reads everything from the shared recording store.
  useDictationOverlaySync();

  const resolveTarget = useCallback(
    () =>
      getPushToTalkTarget() ??
      (assistantId ? fallbackVoiceInputRef.current : null),
    [assistantId],
  );

  useEffect(() => {
    return subscribeToDictationOverlayStop(() => {
      if (useVoiceRecordingStore.getState().phase !== "recording") return;
      resolveTarget()?.stop();
    });
  }, [resolveTarget]);

  usePushToTalk(resolveTarget, { enabled: shouldEnablePushToTalk() });

  const handleTranscript = useCallback(
    async (rawText: string): Promise<void> => {
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

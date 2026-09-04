import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import type { DictationContext } from "@vellumai/assistant-api";
import type { HotkeySelection } from "@vellumai/ipc-contract";

import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useDictationOverlaySync } from "@/domains/chat/hooks/use-dictation-overlay-sync";
import { formatVoiceError } from "@/domains/chat/utils/chat";
import { postDictation } from "@/domains/chat/voice/dictation-api";
import {
  announceAskRefused,
  askVoiceFromSurface,
  toggleVoiceFromSurface,
} from "@/domains/chat/voice/live-voice/start-voice-request";
import { getPushToTalkTarget } from "@/domains/chat/voice/push-to-talk-target";
import { supportsKeyboardActivation } from "@/domains/chat/voice/keyboard-activation-host";
import { useAudioAmplitude } from "@/domains/chat/voice/use-audio-amplitude";
import {
  armDictationOfferWatch,
  clearDictationOffer,
  setDictationOffer,
} from "@/domains/chat/voice/dictation-offer-store";
import {
  findRunningFnClaimant,
  type FnClaimant,
} from "@/domains/chat/voice/fn-claimants";
import { useVoiceKey } from "@/domains/chat/voice/use-voice-key";
import { useVoiceModeHotkey } from "@/domains/chat/voice/use-voice-mode-hotkey";
import {
  markHoldDictation,
  useVoiceKey as useVoiceKeySetting,
} from "@/utils/voice-key";
import { useVoiceKeyRegistrationStore } from "@/stores/voice-key-registration-store";
import { mintVoiceDraftConversation } from "@/domains/chat/voice/voice-draft-conversation";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import type { DictationPostResponse } from "@/generated/daemon/types.gen";
import { supportsSelectionRewrite } from "@/lib/backwards-compat/selection-rewrite";
import { subscribeToDictationOverlayStop } from "@/runtime/dictation-overlay";
import { insertTextIntoFrontApp } from "@/runtime/text-insertion";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";
import { frontmostApp } from "@/runtime/running-apps";
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

/**
 * How long a hold gives the daemon to rewrite a selection before the words go
 * to the assistant as a question instead.
 *
 * Its own bound rather than the cleanup's. A cleanup tidies a sentence and
 * answers in a second or two whatever was said; a rewrite writes back as much
 * as it was handed, and a paragraph takes the model as long as a paragraph
 * takes. Under the cleanup's bound a long selection's edit was dropped at
 * the deadline and the hold fell through to the ask, which read an answer
 * aloud when the user had asked for the text in front of them changed. The
 * user is watching their selection while it runs, so the wait is a wait and
 * not a hang; what has to hold is that a rewrite asked for is a rewrite
 * delivered.
 */
const REWRITE_DEADLINE_MS = 20_000;

/**
 * The turn a hold made over a selection becomes: the selection, quoted, and
 * then the words. The selection comes first because it is what the words are
 * about, and quoted so the model and the transcript both read it as something
 * the user is pointing at rather than something they said. A selection the
 * helper cut short says so, so the model does not reason about an ending it
 * never saw.
 */
export function composeSelectionAsk(
  selection: HotkeySelection,
  words: string,
): string {
  const quoted = selection.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const tail = selection.truncated ? "\n> [selection continues]" : "";
  return `${quoted}${tail}\n\n${words}`;
}

/**
 * The cleanup pass raced against a deadline rather than awaited, so a daemon
 * that is not answering costs the hold the deadline and no more. Past it the
 * late answer is dropped.
 */
async function postDictationWithDeadline(
  words: string,
  assistantId: string,
  context: DictationContext,
  deadlineMs: number = CLEANUP_DEADLINE_MS,
): Promise<DictationPostResponse | null> {
  const abort = new AbortController();
  return Promise.race([
    postDictation(words, assistantId, context, abort.signal),
    new Promise<null>((resolve) => {
      setTimeout(() => {
        abort.abort();
        resolve(null);
      }, deadlineMs);
    }),
  ]);
}

/**
 * Whether what a hold's words ask for can go back where the selection is.
 *
 * Editable, so a paste replaces the selection rather than landing nowhere.
 * Whole, because the helper cuts a long selection short, and a rewrite of the
 * part it kept pasted over all of it would take the rest with it.
 */
function canRewriteInPlace(selection: HotkeySelection): boolean {
  return selection.editable && !selection.truncated;
}

/**
 * What the words asked to be put in the selection's place, or null when they
 * asked about it instead.
 *
 * The daemon reads the words over the selection and answers with the edit,
 * or says they were a question. No answer in time, and the selection handed
 * back as it was, are nothing to put anywhere either, and the words go to the
 * assistant as the question they may well be. Character counts and timings
 * only in the log.
 */
async function requestSelectionRewrite(
  words: string,
  selection: HotkeySelection,
  assistantId: string,
): Promise<string | null> {
  const startedAt = Date.now();
  const result = await postDictationWithDeadline(
    words,
    assistantId,
    {
      cursorInTextField: true,
      selectedText: selection.text,
    },
    REWRITE_DEADLINE_MS,
  );
  const edited = result?.mode === "command" ? result.text.trim() : "";
  const rewrite = edited && edited !== selection.text.trim() ? edited : null;
  console.info(
    `dictation: rewrite ${result ? result.mode : "skipped"} selectionChars=${selection.text.length} words=${words.length} outChars=${rewrite?.length ?? 0} ms=${Date.now() - startedAt}`,
  );
  return rewrite;
}

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

/**
 * Put text at the cursor in the application in front, and where that cannot
 * be done, in the composer, so nothing said is lost. A paste the system turned
 * away says so once, with a stable id, and marks the recording so the overlay
 * shows the failure rather than a check.
 */
async function landInFrontApp(
  text: string,
  assistantId: string | null,
): Promise<void> {
  const insertStartedAt = Date.now();
  const frontAppInsertion = await insertTextIntoFrontApp(text);
  console.info(
    `dictation: inserted chars=${text.length} status=${frontAppInsertion.status} ms=${Date.now() - insertStartedAt}`,
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
  const nextInput = appendTranscript(composer.input, text);
  composer.setInput(nextInput);
  composer.saveDraft(conversationKey, nextInput);
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
  const voiceKey = useVoiceKeySetting();
  const setVoiceKeyRegistered = useVoiceKeyRegistrationStore(
    (state) => state.setRegistered,
  );
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  // What the hold in progress began over. Read when its transcript lands,
  // which decides whether the words go to the cursor or to the assistant.
  const holdSelectionRef = useRef<Promise<HotkeySelection | null> | null>(null);
  // Which other dictation app, if any, was running when the hold began, and
  // so heard the same key. Asked at the start rather than at the end: it is
  // the app that pasted first that the offer names, and one launched while
  // the user was talking heard none of it.
  const holdClaimantRef = useRef<Promise<FnClaimant | null> | null>(null);
  // The application in front as the hold began, which is where a claimant
  // pasted and so the only place "use" may undo.
  const holdFrontAppRef = useRef<Promise<string | null> | null>(null);

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
  // While the voice key is bound, the companion surface carries the status
  // instead: one surface saying a microphone is open rather than a panel and
  // a pill saying it separately.
  useDictationOverlaySync({ suppressed: voiceKey.kind !== "off" });

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

  // The voice key, from whatever app the user is in. A hold drives the same
  // target the overlay's stop button drives, so a hold and a press are the
  // same dictation and land the same way: through `handleTranscript` below,
  // which cleans the transcript up and drops it at the cursor. A hold made
  // over a selection is the one exception: its words are a question about the
  // selection, and go to the assistant instead. A double tap is Talk.
  useVoiceKey({
    key: voiceKey,
    onRegistered: setVoiceKeyRegistered,
    onHoldStart: ({ selection }) => {
      if (useVoiceRecordingStore.getState().phase === "recording") {
        return;
      }
      // Read by the recording session as it starts, which decides there
      // whether the local transcript is the authority.
      markHoldDictation(true);
      // The selection binds to the recording that began over it and to no
      // other. A hold the recorder refuses (the previous transcript is still
      // being finished) leaves the previous hold's selection where it was,
      // so that transcript is still about what it was held over.
      if (holdTarget()?.start() === true) {
        holdSelectionRef.current = selection;
        // Only the window that can publish an offer makes one. A pop-out can
        // own the key (main routes the edges to the last focused window) but
        // the companion mirror publishes from the main window alone, so an
        // offer made here would be one nobody is ever shown. A pop-out pastes
        // as it always did.
        holdClaimantRef.current = isPopoutWindowLifetime()
          ? null
          : findRunningFnClaimant();
        holdFrontAppRef.current = frontmostApp();
        // A new hold is a new question. An offer still standing from the
        // last one would otherwise outlive it, and be answered onto words
        // the user has moved past.
        clearDictationOffer();
      }
    },
    onHoldEnd: () => {
      markHoldDictation(false);
      if (useVoiceRecordingStore.getState().phase !== "recording") {
        return;
      }
      holdTarget()?.stop();
      // From here the other app's paste is the last edit, and the cleanup
      // pass stands between this and the offer. Watch from now so a press in
      // that gap is seen: after one, there is nothing safe left to replace.
      if (holdClaimantRef.current !== null) {
        armDictationOfferWatch();
      }
    },
    onDoubleTap: () => {
      toggleVoiceFromSurface((to, options) => navigateRef.current(to, options));
    },
  });

  const handleTranscript = useCallback(
    async (rawText: string): Promise<void> => {
      const pendingSelection = holdSelectionRef.current;
      holdSelectionRef.current = null;
      const pendingClaimant = holdClaimantRef.current;
      holdClaimantRef.current = null;
      const pendingFrontApp = holdFrontAppRef.current;
      holdFrontAppRef.current = null;
      const selection = pendingSelection ? await pendingSelection : null;
      if (selection !== null) {
        // Words over an editable selection may be asking for it changed. The
        // daemon reads them either way: an edit comes back to be put where
        // the selection is, and a question falls through to the ask below.
        if (
          assistantId &&
          canRewriteInPlace(selection) &&
          supportsSelectionRewrite(assistantId)
        ) {
          const rewrite = await requestSelectionRewrite(
            rawText,
            selection,
            assistantId,
          );
          if (rewrite !== null) {
            await landInFrontApp(rewrite, assistantId);
            return;
          }
        }
        // A question about what was highlighted. Not pasted, and not cleaned
        // up: the cleanup pass rewrites words meant for a document, and these
        // are meant for the assistant, who hears them as said. The reply is
        // spoken, on the call the companion shows while it plays.
        const ask = composeSelectionAsk(selection, rawText);
        const taken = askVoiceFromSurface(
          (to, options) => navigateRef.current(to, options),
          ask,
        );
        console.info(
          `dictation: ask selectionChars=${selection.text.length} truncated=${selection.truncated} words=${rawText.length} taken=${taken}`,
        );
        if (!taken) {
          announceAskRefused();
        }
        return;
      }
      let insertText = rawText;
      // The cleanup pass: one model call that punctuates, drops the fillers,
      // adapts the tone to the application in front and applies the user's
      // own style. It is what turns "grocery list, onions, tomatoes" into a
      // list, and the only leg of this that can. A hold takes it too, now that
      // nothing else on its path is worth waiting for; what it costs is
      // measured rather than assumed. Character counts and timings only.
      const cleanupStartedAt = Date.now();
      const dictationResult = assistantId
        ? await postDictationWithDeadline(rawText, assistantId, {
            cursorInTextField: true,
          })
        : null;
      if (dictationResult?.mode === "dictation" && dictationResult.text) {
        insertText = dictationResult.text;
      }
      console.info(
        `dictation: cleanup ${dictationResult ? dictationResult.mode : "skipped"} inChars=${rawText.length} outChars=${insertText.length} ms=${Date.now() - cleanupStartedAt}`,
      );
      // Another dictation app heard the same key and has pasted by now.
      // Pasting beside it would leave the sentence twice, so the words are
      // offered on the companion instead, and land only if asked to.
      const claimant = pendingClaimant ? await pendingClaimant : null;
      if (claimant !== null) {
        const offered = setDictationOffer(
          claimant,
          insertText,
          pendingFrontApp ? await pendingFrontApp : null,
        );
        console.info(
          `dictation: ${offered ? "offered" : "dropped"} instead of pasted, beside ${claimant.bundleId} chars=${insertText.length}`,
        );
        return;
      }
      await landInFrontApp(insertText, assistantId);
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

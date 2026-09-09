import { toast } from "@vellumai/design-library/components/toast";
import { create } from "zustand";

import { synthesizeMessagePlayback } from "@/domains/chat/message-read-aloud-tts";
import { t } from "@/i18n";
import { createSelectors } from "@/utils/create-selectors";

/**
 * One-sample silent WAV. iOS WKWebView often blocks `audio.play()` after an
 * `await` (the user-gesture flag is gone). Playing this clip synchronously in
 * the click handler unlocks the same `HTMLAudioElement` for the synthesized
 * blob that arrives later.
 */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

export type MessageReadAloudStatus = "idle" | "loading" | "playing";

interface MessageReadAloudState {
  messageId: string | null;
  status: MessageReadAloudStatus;
}

interface MessageReadAloudActions {
  toggle: (params: {
    messageId: string;
    text: string;
    assistantId: string | null;
    conversationId?: string | null;
  }) => void;
  stop: () => void;
}

export type MessageReadAloudStore = MessageReadAloudState &
  MessageReadAloudActions;

let playbackGeneration = 0;
let mediaGeneration = 0;
let objectUrl: string | null = null;
let sharedAudio: HTMLAudioElement | null = null;

function getSpeechSynthesis(): SpeechSynthesis | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return null;
  }
  const synth = window.speechSynthesis;
  if (!synth) {
    return null;
  }
  return synth;
}

function revokeObjectUrl(): void {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

function getSharedAudio(): HTMLAudioElement {
  if (!sharedAudio) {
    sharedAudio = new Audio();
    sharedAudio.addEventListener("ended", () => {
      if (playbackGeneration !== mediaGeneration) {
        return;
      }
      if (useMessageReadAloudStoreBase.getState().status === "playing") {
        finishPlayback();
      }
    });
    sharedAudio.addEventListener("error", () => {
      if (playbackGeneration !== mediaGeneration) {
        return;
      }
      if (useMessageReadAloudStoreBase.getState().status === "playing") {
        finishPlayback();
      }
    });
  }
  return sharedAudio;
}

function cancelWebSpeech(): void {
  const synth = getSpeechSynthesis();
  if (!synth) {
    return;
  }
  try {
    synth.cancel();
  } catch {
    // SpeechSynthesis.cancel can throw in some webviews.
  }
}

function haltMedia(): void {
  if (sharedAudio) {
    sharedAudio.pause();
    sharedAudio.removeAttribute("src");
    try {
      sharedAudio.load();
    } catch {
      // Some webviews throw if load() runs with no source.
    }
  }
  revokeObjectUrl();
  cancelWebSpeech();
}

function finishPlayback(): void {
  playbackGeneration += 1;
  haltMedia();
  useMessageReadAloudStoreBase.setState({ messageId: null, status: "idle" });
}

function unlockPlayback(): HTMLAudioElement {
  const audio = getSharedAudio();
  audio.src = SILENT_WAV;
  void audio.play().catch(() => {
    // The silent clip is only an unlock; blob playback is the real attempt.
  });
  return audio;
}

function primeWebSpeech(): void {
  const synth = getSpeechSynthesis();
  if (!synth) {
    return;
  }
  try {
    synth.resume();
    const primer = new SpeechSynthesisUtterance(" ");
    primer.volume = 0;
    synth.speak(primer);
    synth.cancel();
  } catch {
    // Web Speech is optional and may reject the primer.
  }
}

function speakWithWebSpeech(text: string, generation: number): boolean {
  const synth = getSpeechSynthesis();
  if (!synth) {
    return false;
  }
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    mediaGeneration = generation;
    utterance.onend = () => {
      if (playbackGeneration !== generation) {
        return;
      }
      finishPlayback();
    };
    utterance.onerror = () => {
      if (playbackGeneration !== generation) {
        return;
      }
      finishPlayback();
    };
    synth.speak(utterance);
    useMessageReadAloudStoreBase.setState({ status: "playing" });
    return true;
  } catch {
    return false;
  }
}

async function playBlob(
  blob: Blob,
  generation: number,
): Promise<boolean> {
  if (typeof URL.createObjectURL !== "function") {
    return false;
  }
  const audio = getSharedAudio();
  revokeObjectUrl();
  const url = URL.createObjectURL(blob);
  objectUrl = url;
  mediaGeneration = generation;
  audio.src = url;
  try {
    await audio.play();
  } catch {
    return false;
  }
  if (playbackGeneration !== generation) {
    return false;
  }
  useMessageReadAloudStoreBase.setState({ status: "playing" });
  return true;
}

function reportPlayFailed(): void {
  toast.error(t("chat:messageHoverActions.playFailed"));
}

async function startPlayback(params: {
  text: string;
  assistantId: string | null;
  conversationId?: string | null;
}): Promise<void> {
  const generation = playbackGeneration;
  if (params.assistantId) {
    const result = await synthesizeMessagePlayback({
      assistantId: params.assistantId,
      text: params.text,
      conversationId: params.conversationId,
    });
    if (playbackGeneration !== generation) {
      return;
    }
    if (result.kind === "audio") {
      const played = await playBlob(result.blob, generation);
      if (playbackGeneration !== generation) {
        return;
      }
      if (played) {
        return;
      }
    }
  }
  if (playbackGeneration !== generation) {
    return;
  }
  if (speakWithWebSpeech(params.text, generation)) {
    return;
  }
  if (playbackGeneration !== generation) {
    return;
  }
  finishPlayback();
  reportPlayFailed();
}

const useMessageReadAloudStoreBase = create<MessageReadAloudStore>()(
  (set, get) => ({
    messageId: null,
    status: "idle",

    toggle: ({ messageId, text, assistantId, conversationId }) => {
      const current = get();
      if (current.messageId === messageId && current.status !== "idle") {
        finishPlayback();
        return;
      }
      const generation = (playbackGeneration += 1);
      set({ messageId, status: "loading" });
      haltMedia();
      unlockPlayback();
      primeWebSpeech();
      void startPlayback({
        text,
        assistantId,
        conversationId,
      }).catch(() => {
        if (playbackGeneration !== generation) {
          return;
        }
        finishPlayback();
        reportPlayFailed();
      });
    },

    stop: () => {
      if (get().status === "idle") {
        return;
      }
      finishPlayback();
    },
  }),
);

export const useMessageReadAloudStore = createSelectors(
  useMessageReadAloudStoreBase,
);

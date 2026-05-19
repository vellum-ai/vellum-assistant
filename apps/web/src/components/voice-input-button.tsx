// TODO: port from platform
import type { Ref } from "react";

export interface VoiceInputButtonHandle {
  startRecording: () => void;
  stopRecording: () => void;
}

export function VoiceInputButton(_props: { ref?: Ref<VoiceInputButtonHandle>; [key: string]: unknown }) {
  return null;
}

// TODO: port from platform
export interface VoiceRecordingState {
  phase: "idle" | "recording" | "processing";
  amplitude?: number;
}

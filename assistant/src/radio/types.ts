export type RadioAdvanceReason = "start" | "song_ended" | "skip" | "retry";

export type RadioDisplayCue =
  | "song"
  | "dj"
  | "transition"
  | "setup_needed"
  | "error";

export interface RadioTrack {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  assetPath: string;
  audioPath: string;
  sourceLabel: string;
  license: "repo-generated";
  sha256: string;
}

export interface RadioAdvanceRequest {
  segmentId?: string;
  currentTrackId?: string;
  recentTrackIds?: readonly string[];
  reason: RadioAdvanceReason;
  locale?: string;
}

export interface RadioAdvanceResponse {
  segmentId: string;
  displayCue: RadioDisplayCue;
  track: RadioTrack;
  playbackPlan: RadioPlaybackPlan;
  djBreak?: RadioDjBreak;
  setup?: RadioSetup;
}

export interface RadioPlaybackPlan {
  track: RadioTrack;
  displayCue: RadioDisplayCue;
  reason: RadioAdvanceReason;
  djBreak?: RadioDjBreak;
}

export interface RadioDjBreak {
  text: string;
  audioPath: string;
  audioId: string;
  contentType: string;
}

export type RadioSetupReason = "tts_not_configured" | "tts_unavailable";

export interface RadioSetup {
  reason: RadioSetupReason;
  settingsPath: "/assistant/settings/ai";
  message: string;
}

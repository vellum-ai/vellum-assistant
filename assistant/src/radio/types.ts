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
  currentTrackId?: string;
  recentTrackIds?: readonly string[];
  reason: RadioAdvanceReason;
}

export interface RadioAdvanceResponse {
  plan: RadioPlaybackPlan;
}

export interface RadioPlaybackPlan {
  track: RadioTrack;
  displayCue: RadioDisplayCue;
  reason: RadioAdvanceReason;
}

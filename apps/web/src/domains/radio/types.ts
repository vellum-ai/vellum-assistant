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
  audioPath: string;
  sourceLabel: string;
  license: "repo-generated";
  sha256: string;
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

export interface RadioPlaybackPlan {
  track: RadioTrack;
  displayCue: RadioDisplayCue;
  reason: RadioAdvanceReason;
  djBreak?: RadioDjBreak;
}

export interface RadioAdvanceRequest {
  segmentId?: string;
  reason: RadioAdvanceReason;
  currentTrackId?: string;
  recentTrackIds?: string[];
  locale?: string;
  timeZone?: string;
}

export interface RadioAdvanceResponse {
  segmentId: string;
  displayCue: RadioDisplayCue;
  track: RadioTrack;
  playbackPlan: RadioPlaybackPlan;
  djBreak?: RadioDjBreak;
  setup?: RadioSetup;
}

export type RadioStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "transitioning"
  | "setup_needed"
  | "error";

export interface ResolvedRadioTrack extends RadioTrack {
  audioUrl: string;
}

export interface ResolvedRadioDjBreak extends RadioDjBreak {
  audioUrl: string;
}

export interface ResolvedRadioPlaybackPlan {
  track: ResolvedRadioTrack;
  displayCue: RadioDisplayCue;
  reason: RadioAdvanceReason;
  djBreak?: ResolvedRadioDjBreak;
}

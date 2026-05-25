import { randomUUID } from "node:crypto";

import type { RadioAdvanceReason, RadioTrack } from "./types.js";

export interface RadioStationState {
  segmentId: string;
  currentTrackId: string;
  recentTrackIds: readonly string[];
  lastGeneratedDjText?: string;
}

let stationState: RadioStationState | null = null;

export function resetRadioStationState(): void {
  stationState = null;
}

export function startRadioStation(track: RadioTrack): RadioStationState {
  stationState = {
    segmentId: createSegmentId(),
    currentTrackId: track.id,
    recentTrackIds: [track.id],
  };
  return stationState;
}

export function getRadioStationState(): RadioStationState | null {
  return stationState;
}

export function isStaleRadioSegment(
  segmentId: string | undefined,
  reason: RadioAdvanceReason,
): boolean {
  if (reason === "start" || !segmentId || !stationState) {
    return false;
  }

  return segmentId !== stationState.segmentId;
}

export function commitRadioTransition(
  track: RadioTrack,
  lastGeneratedDjText?: string,
): RadioStationState {
  const recentTrackIds = capRecentTrackIds([
    track.id,
    ...(stationState?.recentTrackIds ?? []),
  ]);

  stationState = {
    segmentId: createSegmentId(),
    currentTrackId: track.id,
    recentTrackIds,
    ...(lastGeneratedDjText ? { lastGeneratedDjText } : {}),
  };
  return stationState;
}

function capRecentTrackIds(trackIds: readonly string[]): readonly string[] {
  const uniqueTrackIds: string[] = [];
  for (const trackId of trackIds) {
    if (!uniqueTrackIds.includes(trackId)) {
      uniqueTrackIds.push(trackId);
    }
    if (uniqueTrackIds.length === 5) {
      break;
    }
  }
  return uniqueTrackIds;
}

function createSegmentId(): string {
  return `radio-segment-${randomUUID()}`;
}

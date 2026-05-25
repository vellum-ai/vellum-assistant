import { randomUUID } from "node:crypto";

import type { RadioAdvanceReason, RadioTrack } from "./types.js";

export interface RadioStationState {
  segmentId: string;
  currentTrackId: string;
  recentTrackIds: readonly string[];
  lastGeneratedDjText?: string;
}

export interface RadioAdvanceToken {
  sequence: number;
  segmentId: string | null;
}

let stationState: RadioStationState | null = null;
let advanceSequence = 0;
let activeAdvanceToken: RadioAdvanceToken | null = null;

export function resetRadioStationState(): void {
  stationState = null;
  advanceSequence += 1;
  activeAdvanceToken = null;
}

export function startRadioStation(track: RadioTrack): RadioStationState {
  advanceSequence += 1;
  activeAdvanceToken = null;
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

export function beginRadioAdvance(
  segmentId: string | undefined,
  reason: RadioAdvanceReason,
): RadioAdvanceToken | null {
  if (isStaleRadioSegment(segmentId, reason)) {
    return null;
  }

  const token = {
    sequence: ++advanceSequence,
    segmentId: stationState?.segmentId ?? null,
  };
  activeAdvanceToken = token;
  return token;
}

export function isCurrentRadioAdvance(token: RadioAdvanceToken): boolean {
  return (
    activeAdvanceToken?.sequence === token.sequence &&
    (stationState?.segmentId ?? null) === token.segmentId
  );
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
  activeAdvanceToken = null;
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

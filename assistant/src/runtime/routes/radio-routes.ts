import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  getRadioTrack,
  listRadioTracks,
  pickFallbackTrack,
} from "../../radio/catalog.js";
import { planRadioDjBreak } from "../../radio/dj-planner.js";
import {
  isRadioTtsSetupRequiredError,
  RADIO_TTS_SETTINGS_PATH,
  synthesizeRadioDjBreak,
} from "../../radio/radio-tts.js";
import {
  commitRadioTransition,
  getRadioStationState,
  isStaleRadioSegment,
  startRadioStation,
} from "../../radio/station-state.js";
import type {
  RadioAdvanceReason,
  RadioAdvanceRequest,
  RadioAdvanceResponse,
  RadioDjBreak,
  RadioSetup,
  RadioTrack,
  RadioTrackResponse,
} from "../../radio/types.js";
import { BadRequestError, NotFoundError, RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { RouteResponse } from "./types.js";

const radioAdvanceRequestSchema = z.object({
  segmentId: z.string().optional(),
  reason: z.enum(["start", "song_ended", "skip", "retry"]).default("start"),
  currentTrackId: z.string().optional(),
  recentTrackIds: z.array(z.string()).optional(),
  locale: z.string().optional(),
});

const radioTrackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  durationMs: z.number().int(),
  audioPath: z.string(),
  sourceLabel: z.string(),
  license: z.literal("repo-generated"),
  sha256: z.string(),
});

const radioDjBreakSchema = z.object({
  text: z.string(),
  audioPath: z.string(),
  audioId: z.string(),
  contentType: z.string(),
});

const radioPlaybackPlanSchema = z.object({
  reason: radioAdvanceRequestSchema.shape.reason,
  displayCue: z.enum(["song", "dj", "transition", "setup_needed", "error"]),
  track: radioTrackSchema,
  djBreak: radioDjBreakSchema.optional(),
});

const radioAdvanceResponseSchema = z.object({
  segmentId: z.string(),
  displayCue: radioPlaybackPlanSchema.shape.displayCue,
  track: radioTrackSchema,
  playbackPlan: radioPlaybackPlanSchema,
  djBreak: radioDjBreakSchema.optional(),
  setup: z
    .object({
      reason: z.enum(["tts_not_configured", "tts_unavailable"]),
      settingsPath: z.literal(RADIO_TTS_SETTINGS_PATH),
      message: z.string(),
    })
    .optional(),
});

async function handleRadioAdvance({
  body,
  abortSignal,
}: RouteHandlerArgs): Promise<RadioAdvanceResponse> {
  const request = parseAdvanceRequest(body);

  if (request.reason === "start") {
    const track = pickFallbackTrack({
      currentTrackId: request.currentTrackId,
      recentTrackIds: request.recentTrackIds,
    });
    const state = startRadioStation(track);
    return buildAdvanceResponse({
      segmentId: state.segmentId,
      reason: request.reason,
      displayCue: "song",
      track,
    });
  }

  if (isStaleRadioSegment(request.segmentId, request.reason)) {
    return responseForCurrentState(request.reason);
  }

  const { nextTrack, djText } = await chooseNextBreak(request, abortSignal);

  try {
    const djBreak = await synthesizeRadioDjBreak(djText, abortSignal);
    const state = commitRadioTransition(nextTrack, djBreak.text);

    return buildAdvanceResponse({
      segmentId: state.segmentId,
      reason: request.reason,
      displayCue: "transition",
      track: nextTrack,
      djBreak,
    });
  } catch (error) {
    const setup = setupFromTtsError(error);
    const state = commitRadioTransition(nextTrack, djText);

    return buildAdvanceResponse({
      segmentId: state.segmentId,
      reason: request.reason,
      displayCue: "setup_needed",
      track: nextTrack,
      setup,
    });
  }
}

async function handleGetRadioTrack({
  pathParams,
}: RouteHandlerArgs): Promise<RouteResponse> {
  const trackId = pathParams?.trackId;
  const track = trackId ? getRadioTrack(trackId) : undefined;
  if (!track) {
    throw new NotFoundError("Radio track not found");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(track.assetPath);
  } catch {
    throw new RouteError(
      "Radio track asset not available",
      "INTERNAL_ERROR",
      500,
      {
        trackId: track.id,
        reason: "asset_read_failed",
      },
    );
  }

  return new RouteResponse(new Uint8Array(bytes), {
    "Content-Type": "audio/wav",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(bytes.length),
  });
}

function parseAdvanceRequest(
  body: RouteHandlerArgs["body"],
): RadioAdvanceRequest {
  const parsed = radioAdvanceRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError("Invalid radio advance request");
  }

  return parsed.data;
}

async function chooseNextBreak(
  request: RadioAdvanceRequest,
  signal?: AbortSignal,
): Promise<{ nextTrack: RadioTrack; djText: string }> {
  const currentState = getRadioStationState();
  const currentTrackId = request.currentTrackId ?? currentState?.currentTrackId;
  const recentTrackIds =
    request.recentTrackIds ?? currentState?.recentTrackIds ?? [];
  const trackCandidates = listRadioTracks();

  try {
    const planned = await planRadioDjBreak({
      reason: request.reason,
      currentTrackId,
      recentTrackIds,
      trackCandidates,
      locale: request.locale,
      signal,
    });
    const plannedTrack = getRadioTrack(planned.nextTrackId);

    if (plannedTrack) {
      return {
        nextTrack: plannedTrack,
        djText: planned.djText,
      };
    }
  } catch {
    // Fall back below. The station should remain playful even when planning
    // takes a wrong turn.
  }

  const fallbackTrack = pickFallbackTrack({ currentTrackId, recentTrackIds });
  return {
    nextTrack: fallbackTrack,
    djText: fallbackDjText(fallbackTrack, request.reason),
  };
}

function responseForCurrentState(
  reason: RadioAdvanceReason,
): RadioAdvanceResponse {
  const state = getRadioStationState();
  const track = state ? getRadioTrack(state.currentTrackId) : undefined;
  if (!state || !track) {
    const fallbackTrack = pickFallbackTrack({});
    const startedState = startRadioStation(fallbackTrack);
    return buildAdvanceResponse({
      segmentId: startedState.segmentId,
      reason,
      displayCue: "song",
      track: fallbackTrack,
    });
  }

  return buildAdvanceResponse({
    segmentId: state.segmentId,
    reason,
    displayCue: "song",
    track,
  });
}

function setupFromTtsError(error: unknown): RadioSetup {
  if (isRadioTtsSetupRequiredError(error)) {
    return {
      reason: error.reason,
      settingsPath: error.settingsPath,
      message: error.message,
    };
  }

  return {
    reason: "tts_unavailable",
    settingsPath: RADIO_TTS_SETTINGS_PATH,
    message:
      "Text to speech is unavailable. Open Settings -> AI to check your configuration.",
  };
}

function buildAdvanceResponse({
  segmentId,
  reason,
  displayCue,
  track,
  djBreak,
  setup,
}: {
  segmentId: string;
  reason: RadioAdvanceReason;
  displayCue: RadioAdvanceResponse["displayCue"];
  track: RadioTrack;
  djBreak?: RadioDjBreak;
  setup?: RadioSetup;
}): RadioAdvanceResponse {
  const trackResponse = toRadioTrackResponse(track);
  const playbackPlan = {
    reason,
    displayCue,
    track: trackResponse,
    ...(djBreak ? { djBreak } : {}),
  };

  return {
    segmentId,
    displayCue,
    track: trackResponse,
    playbackPlan,
    ...(djBreak ? { djBreak } : {}),
    ...(setup ? { setup } : {}),
  };
}

function toRadioTrackResponse(track: RadioTrack): RadioTrackResponse {
  const { assetPath: _assetPath, ...trackResponse } = track;
  return trackResponse;
}

function fallbackDjText(track: RadioTrack, reason: RadioAdvanceReason): string {
  if (reason === "skip") {
    return `Quick turn of the dial: ${track.title} by ${track.artist} is up next.`;
  }

  if (reason === "retry") {
    return `The station found its footing again. Here comes ${track.title} by ${track.artist}.`;
  }

  return `A tiny station shimmer, then ${track.title} by ${track.artist}.`;
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "radio_advance",
    endpoint: "radio/advance",
    method: "POST",
    summary: "Advance assistant radio playback",
    description:
      "Choose the next assistant radio track and optionally synthesize a short DJ break.",
    tags: ["radio"],
    requestBody: radioAdvanceRequestSchema,
    responseBody: radioAdvanceResponseSchema,
    handler: handleRadioAdvance,
  },
  {
    operationId: "radio_track_get",
    endpoint: "radio/tracks/:trackId",
    method: "GET",
    summary: "Get assistant radio demo track",
    description: "Serve a generated assistant radio demo WAV track.",
    tags: ["radio"],
    pathParams: [
      {
        name: "trackId",
        type: "string",
        description: "Radio track identifier",
      },
    ],
    additionalResponses: {
      404: { description: "Radio track not found" },
    },
    handler: handleGetRadioTrack,
  },
];

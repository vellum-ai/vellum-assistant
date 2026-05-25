import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { RadioDjBreak, RadioTrack } from "../../../radio/types.js";
import { NotFoundError } from "../errors.js";
import { RouteResponse } from "../types.js";

let plannerResult: {
  nextTrackId: string;
  nextTrack: RadioTrack;
  djText: string;
} | null;
let plannerError: Error | null;
let plannerCalls: Array<Record<string, unknown>>;
let ttsResult: RadioDjBreak;
let ttsError: Error | null;
let ttsCalls: Array<{ text: string; signal?: AbortSignal }>;

class MockRadioTtsSetupRequiredError extends Error {
  readonly settingsPath = "/assistant/settings/ai" as const;

  constructor(
    readonly reason: "tts_not_configured" | "tts_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RadioTtsSetupRequiredError";
  }
}

mock.module("../../../radio/dj-planner.js", () => ({
  planRadioDjBreak: async (params: Record<string, unknown>) => {
    plannerCalls.push(params);
    if (plannerError) throw plannerError;
    if (!plannerResult) throw new Error("plannerResult was not set");
    return plannerResult;
  },
  RadioDjPlannerError: class RadioDjPlannerError extends Error {},
}));

mock.module("../../../radio/radio-tts.js", () => ({
  RADIO_TTS_SETTINGS_PATH: "/assistant/settings/ai",
  synthesizeRadioDjBreak: async (text: string, signal?: AbortSignal) => {
    ttsCalls.push({ text, signal });
    if (ttsError) throw ttsError;
    return ttsResult;
  },
  isRadioTtsSetupRequiredError: (error: unknown) =>
    error instanceof MockRadioTtsSetupRequiredError,
}));

const { getRadioTrack } = await import("../../../radio/catalog.js");
const { resetRadioStationState } =
  await import("../../../radio/station-state.js");
const { ROUTES } = await import("../radio-routes.js");

function getRoute(endpoint: string, method: string) {
  const route = ROUTES.find(
    (candidate) =>
      candidate.endpoint === endpoint && candidate.method === method,
  );
  if (!route) throw new Error(`${method} ${endpoint} not found`);
  return route;
}

function expectClientTrackResponse(track: unknown, expectedAudioPath: string) {
  expect(track).toBeObject();
  const record = track as Record<string, unknown>;

  expect(record.assetPath).toBeUndefined();
  expect(record.audioPath).toBe(expectedAudioPath);
  expect(String(record.audioPath).startsWith("radio/tracks/")).toBe(true);
  expect(String(record.audioPath).startsWith("/")).toBe(false);
}

const softLaunch = getRadioTrack("soft-launch")!;
const bufferBloom = getRadioTrack("buffer-bloom")!;
const neonPostcard = getRadioTrack("neon-postcard")!;

describe("radio routes", () => {
  beforeEach(() => {
    resetRadioStationState();
    plannerResult = {
      nextTrackId: bufferBloom.id,
      nextTrack: bufferBloom,
      djText: "A little shimmer, then Buffer Bloom arrives.",
    };
    plannerError = null;
    plannerCalls = [];
    ttsResult = {
      text: "A little shimmer, then Buffer Bloom arrives.",
      audioId: "audio-123",
      audioPath: "audio/audio-123",
      contentType: "audio/mpeg",
    };
    ttsError = null;
    ttsCalls = [];
  });

  test("start returns an initialized song response with a playable track path", async () => {
    const route = getRoute("radio/advance", "POST");

    const response = await route.handler({
      body: { reason: "start" },
    });

    expect(response).toMatchObject({
      displayCue: "song",
      track: {
        audioPath: softLaunch.audioPath,
      },
      playbackPlan: {
        displayCue: "song",
        reason: "start",
        track: {
          audioPath: softLaunch.audioPath,
        },
      },
    });
    expect(typeof (response as { segmentId: string }).segmentId).toBe("string");
    expect((response as { djBreak?: unknown }).djBreak).toBeUndefined();
    expectClientTrackResponse(
      (response as { track: unknown }).track,
      softLaunch.audioPath,
    );
    expectClientTrackResponse(
      (response as { playbackPlan: { track: unknown } }).playbackPlan.track,
      softLaunch.audioPath,
    );
    expect(plannerCalls).toHaveLength(0);
    expect(ttsCalls).toHaveLength(0);
  });

  test("transition response includes DJ audio and playback plan", async () => {
    const route = getRoute("radio/advance", "POST");
    const start = (await route.handler({
      body: { reason: "start" },
    })) as { segmentId: string };

    const response = await route.handler({
      body: {
        reason: "song_ended",
        segmentId: start.segmentId,
        currentTrackId: softLaunch.id,
        recentTrackIds: [softLaunch.id],
        locale: "en-US",
      },
    });

    expect(plannerCalls).toHaveLength(1);
    expect(plannerCalls[0]).toMatchObject({
      reason: "song_ended",
      currentTrackId: softLaunch.id,
      recentTrackIds: [softLaunch.id],
      locale: "en-US",
    });
    expect(ttsCalls).toEqual([
      {
        text: "A little shimmer, then Buffer Bloom arrives.",
        signal: undefined,
      },
    ]);
    expect(response).toMatchObject({
      displayCue: "transition",
      track: { id: bufferBloom.id },
      djBreak: {
        text: "A little shimmer, then Buffer Bloom arrives.",
        audioPath: "audio/audio-123",
      },
      playbackPlan: {
        displayCue: "transition",
        reason: "song_ended",
        track: { id: bufferBloom.id },
        djBreak: {
          audioPath: "audio/audio-123",
        },
      },
    });
    expectClientTrackResponse(
      (response as { track: unknown }).track,
      bufferBloom.audioPath,
    );
    expectClientTrackResponse(
      (response as { playbackPlan: { track: unknown } }).playbackPlan.track,
      bufferBloom.audioPath,
    );
  });

  test("missing TTS returns setup-needed with the settings path", async () => {
    const route = getRoute("radio/advance", "POST");
    const start = (await route.handler({
      body: { reason: "start" },
    })) as { segmentId: string };
    ttsError = new MockRadioTtsSetupRequiredError(
      "tts_not_configured",
      "Text to speech is not configured.",
    );

    const response = await route.handler({
      body: { reason: "song_ended", segmentId: start.segmentId },
    });

    expect(response).toMatchObject({
      displayCue: "setup_needed",
      track: { id: bufferBloom.id },
      setup: {
        reason: "tts_not_configured",
        settingsPath: "/assistant/settings/ai",
      },
      playbackPlan: {
        displayCue: "setup_needed",
        track: { id: bufferBloom.id },
      },
    });
    expect((response as { djBreak?: unknown }).djBreak).toBeUndefined();
  });

  test("planner failure and invalid track choices recover to fallback tracks", async () => {
    const route = getRoute("radio/advance", "POST");
    const start = (await route.handler({
      body: { reason: "start" },
    })) as { segmentId: string };
    plannerError = new Error("planner is tired");

    const failureResponse = await route.handler({
      body: {
        reason: "skip",
        segmentId: start.segmentId,
        currentTrackId: softLaunch.id,
        recentTrackIds: [softLaunch.id],
      },
    });

    expect(failureResponse).toMatchObject({
      displayCue: "transition",
      track: { id: bufferBloom.id },
    });
    expect(ttsCalls[0]!.text).toContain(bufferBloom.title);

    plannerError = null;
    plannerResult = {
      nextTrackId: "not-in-catalog",
      nextTrack: {
        ...bufferBloom,
        id: "not-in-catalog",
        audioPath: "radio/tracks/not-in-catalog",
      },
      djText: "This invalid choice should be replaced.",
    };
    const currentSegment = (failureResponse as { segmentId: string }).segmentId;

    const invalidResponse = await route.handler({
      body: {
        reason: "retry",
        segmentId: currentSegment,
        currentTrackId: bufferBloom.id,
        recentTrackIds: [bufferBloom.id],
      },
    });

    expect(invalidResponse).toMatchObject({
      displayCue: "transition",
      track: { id: softLaunch.id },
    });
    expect(ttsCalls.at(-1)!.text).toContain(softLaunch.title);
  });

  test("stale segment requests return current state without advancing", async () => {
    const route = getRoute("radio/advance", "POST");
    const start = (await route.handler({
      body: { reason: "start" },
    })) as { segmentId: string };
    const transition = (await route.handler({
      body: { reason: "song_ended", segmentId: start.segmentId },
    })) as { segmentId: string; track: RadioTrack };

    const staleResponse = await route.handler({
      body: { reason: "skip", segmentId: start.segmentId },
    });

    expect(staleResponse).toMatchObject({
      segmentId: transition.segmentId,
      displayCue: "song",
      track: { id: transition.track.id },
    });
    expect(plannerCalls).toHaveLength(1);
    expect(ttsCalls).toHaveLength(1);
  });

  test("track route returns WAV bytes and immutable cache headers", async () => {
    const route = getRoute("radio/tracks/:trackId", "GET");

    const response = await route.handler({
      pathParams: { trackId: neonPostcard.id },
    });

    expect(response).toBeInstanceOf(RouteResponse);
    const routeResponse = response as RouteResponse;
    const expectedBytes = await readFile(neonPostcard.assetPath);
    expect(routeResponse.headers).toEqual({
      "Content-Type": "audio/wav",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(expectedBytes.length),
    });
    expect(routeResponse.body).toEqual(new Uint8Array(expectedBytes));
  });

  test("track route returns 404 for unknown tracks", async () => {
    const route = getRoute("radio/tracks/:trackId", "GET");

    await expect(
      route.handler({ pathParams: { trackId: "missing-track" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

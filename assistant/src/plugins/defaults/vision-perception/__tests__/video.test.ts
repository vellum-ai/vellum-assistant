import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ImageContent, Message } from "../../../../providers/types.js";
import type { ToolContext } from "../../../../tools/types.js";

// `mock.module` is process-global, so all stubbing for vlm_video_log lives in
// this one file (the test runner runs each file in its own process). We stub:
//  - frame extraction (`video-frames.js` `sampleVideoFrames`), spreading the
//    real module so `VideoFramesError` keeps its identity for the `instanceof`
//    check in `resolveVisionVideo`;
//  - the attachment store (a configurable video row), so `resolveVisionVideo`
//    can validate the kind without a real DB;
//  - the provider resolution (spreading the real module so `extractAllText`
//    still works).

const realVideoFrames = await import("../src/video-frames.js");
type SampledVideo = Awaited<
  ReturnType<typeof realVideoFrames.sampleVideoFrames>
>;
const { VideoFramesError, planTimestamps, END_EPSILON_S } = realVideoFrames;

// A 1x1 JPEG-ish payload; frames are pre-built fixtures so no ffmpeg runs.
const FRAME_DATA = "ZmFrZS1mcmFtZQ==";

function fixtureFrame(t: number): { t_seconds: number; block: ImageContent } {
  return {
    t_seconds: t,
    block: {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: FRAME_DATA },
    },
  };
}

// Per-test control: either a fixture video to return, or an error to throw.
let sampleResult: SampledVideo | null = null;
let sampleError: Error | null = null;

mock.module("../src/video-frames.js", () => ({
  ...realVideoFrames,
  sampleVideoFrames: async (): Promise<SampledVideo> => {
    if (sampleError) throw sampleError;
    return sampleResult!;
  },
}));

interface FakeRow {
  id: string;
  originalFilename: string;
  mimeType: string;
  kind: string;
}

let attachmentRows: Record<string, FakeRow> = {};
mock.module("../../../../memory/attachments-store.js", () => ({
  getAttachmentById: (id: string) => attachmentRows[id] ?? null,
  getAttachmentContent: () => null,
  getFilePathForAttachment: () => null,
}));

let sendMessageArgs: { messages: Message[]; options: unknown } | null = null;
let responseText = "";

const fakeProvider = {
  name: "mock-vision-provider",
  async sendMessage(messages: Message[], options: unknown) {
    sendMessageArgs = { messages, options };
    return {
      content: [{ type: "text", text: responseText }],
      model: "mock-vision-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  },
};

const realPsm = await import("../../../../providers/provider-send-message.js");
mock.module("../../../../providers/provider-send-message.js", () => ({
  ...realPsm,
  getConfiguredProvider: async () => fakeProvider,
}));

// The execution guard checks the visionPerception call site resolves to an
// enabled vision-capable provider. Keep it available for these tests.
mock.module("../src/vision-capability.js", () => ({
  isVisionPerceptionProviderAvailable: () => true,
  VISION_CALL_SITE: "visionPerception",
}));

const vlmVideoLogTool = (await import("../tools/vlm-video-log.js")).default;

const ctx = { conversationId: "c1" } as unknown as ToolContext;

beforeEach(() => {
  sampleResult = null;
  sampleError = null;
  sendMessageArgs = null;
  responseText = "";
  attachmentRows = {
    "vid-1": {
      id: "vid-1",
      originalFilename: "clip.mp4",
      mimeType: "video/mp4",
      kind: "video",
    },
    "img-1": {
      id: "img-1",
      originalFilename: "photo.png",
      mimeType: "image/png",
      kind: "image",
    },
  };
});

describe("vlm_video_log tool", () => {
  test("samples keyframes and returns a timestamped event log", async () => {
    sampleResult = {
      duration_s: 12,
      frames: [fixtureFrame(0), fixtureFrame(6), fixtureFrame(12)],
    };
    responseText = JSON.stringify({
      segments: [
        { t_start: 0, t_end: 6, summary: "intro", events: ["title card"] },
        { t_start: 6, t_end: 12, summary: "demo", events: ["click", "type"] },
      ],
    });

    const result = await vlmVideoLogTool.execute?.({ media_ref: "vid-1" }, ctx);

    expect(result?.isError).toBe(false);
    const parsed = JSON.parse(result?.content ?? "");
    expect(parsed.duration_s).toBe(12);
    expect(parsed.segments).toEqual([
      { t_start: 0, t_end: 6, summary: "intro", events: ["title card"] },
      { t_start: 6, t_end: 12, summary: "demo", events: ["click", "type"] },
    ]);
    expect(parsed.truncated).toBeUndefined();
  });

  test("sends each frame as a labeled image block to the vision model", async () => {
    sampleResult = {
      duration_s: 4,
      frames: [fixtureFrame(0), fixtureFrame(4)],
    };
    responseText = JSON.stringify({ segments: [] });

    await vlmVideoLogTool.execute?.(
      { media_ref: "vid-1", query: "what changes?" },
      ctx,
    );

    const sent = sendMessageArgs?.messages;
    expect(sent).toHaveLength(1);
    const blocks = sent?.[0].content ?? [];

    const images = blocks.filter((b): b is ImageContent => b.type === "image");
    expect(images).toHaveLength(2);
    expect(images[0].source.data).toBe(FRAME_DATA);

    const labels = blocks.filter((b) => b.type === "text");
    expect(labels.some((b) => b.text === "[t=0s]")).toBe(true);
    expect(labels.some((b) => b.text === "[t=4s]")).toBe(true);
    // The query is threaded into the trailing prompt block.
    expect(labels.some((b) => b.text.includes("what changes?"))).toBe(true);
  });

  test("propagates the truncation descriptor when frames were capped", async () => {
    sampleResult = {
      duration_s: 300,
      frames: [fixtureFrame(0), fixtureFrame(150), fixtureFrame(300)],
      truncated: {
        reason: "frame count capped at 32 (sampling asked for 150)",
        requested: 150,
        returned: 3,
        covered_window: [0, 300],
      },
    };
    responseText = JSON.stringify({ segments: [] });

    const result = await vlmVideoLogTool.execute?.({ media_ref: "vid-1" }, ctx);

    expect(result?.isError).toBe(false);
    const parsed = JSON.parse(result?.content ?? "");
    expect(parsed.truncated).toEqual({
      reason: "frame count capped at 32 (sampling asked for 150)",
      requested: 150,
      returned: 3,
      covered_window: [0, 300],
    });
  });

  test("ffmpeg unavailable degrades to isError (no throw)", async () => {
    sampleError = new VideoFramesError(
      "ffmpeg is not available, so extracting a video frame is not possible in this environment.",
    );

    const result = await vlmVideoLogTool.execute?.({ media_ref: "vid-1" }, ctx);

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("ffmpeg is not available");
    expect(sendMessageArgs).toBeNull();
  });

  test("returns isError (no throw) for a non-video attachment", async () => {
    responseText = JSON.stringify({ segments: [] });
    const result = await vlmVideoLogTool.execute?.({ media_ref: "img-1" }, ctx);

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("not a video");
    expect(sendMessageArgs).toBeNull();
  });

  test("returns isError (no throw) for a missing media_ref", async () => {
    const result = await vlmVideoLogTool.execute?.(
      { media_ref: "does-not-exist" },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("No attachment found");
    expect(sendMessageArgs).toBeNull();
  });

  test("malformed model output degrades to isError (no throw)", async () => {
    sampleResult = { duration_s: 4, frames: [fixtureFrame(0)] };
    responseText = "sorry, I can't analyze that video";

    const result = await vlmVideoLogTool.execute?.({ media_ref: "vid-1" }, ctx);

    expect(result?.isError).toBe(true);
  });
});

describe("planTimestamps avoids seeking to the video's end (EOF)", () => {
  // Regression for Codex P1: the last sampled timestamp used to equal the
  // duration, so ffmpeg seeked to EOF and produced no frame, turning ordinary
  // clips > ~2s into `{ isError: true }` results.
  test("no sampled timestamp equals the duration for a multi-frame clip", () => {
    const durationS = 10;
    const { timestamps } = planTimestamps(durationS, 0, durationS, "keyframes");

    expect(timestamps.length).toBeGreaterThan(1);
    for (const t of timestamps) {
      expect(t).toBeLessThan(durationS);
    }
    // The final timestamp is pulled back by exactly the EOF epsilon.
    expect(timestamps[timestamps.length - 1]).toBeCloseTo(
      durationS - END_EPSILON_S,
      6,
    );
  });

  test("the cap holds for every uniform strategy and an explicit full window", () => {
    const durationS = 30;
    for (const strategy of ["uniform_1hz", "uniform_4hz"] as const) {
      const { timestamps } = planTimestamps(durationS, 0, durationS, strategy);
      expect(Math.max(...timestamps)).toBeLessThan(durationS);
      expect(Math.max(...timestamps)).toBeLessThanOrEqual(
        durationS - END_EPSILON_S,
      );
    }
  });

  test("a single-frame clip still samples a valid, non-negative timestamp", () => {
    // A very short clip (sub-epsilon) must not yield a negative seek time.
    const tiny = planTimestamps(0.05, 0, 0.05, "keyframes");
    expect(tiny.timestamps).toHaveLength(1);
    expect(tiny.timestamps[0]).toBeGreaterThanOrEqual(0);
    expect(tiny.timestamps[0]).toBeLessThanOrEqual(0.05);

    // A normal short clip samples near the middle, still below the duration.
    const short = planTimestamps(1.5, 0, 1.5, "keyframes");
    expect(short.timestamps).toHaveLength(1);
    expect(short.timestamps[0]).toBeLessThan(1.5);
  });
});

/**
 * The `vlm_video_log` tool — reads a provided video and returns a timestamped
 * event log.
 *
 * The model passes the video's attachment id as `media_ref`, optionally a
 * `query` to focus the log, a `sample` strategy, and a `window` to restrict the
 * span. The plugin samples timestamped keyframes (via `video-frames.ts`, which
 * relies on ffmpeg and degrades to an error when it is unavailable), sends the
 * frames plus the query to the `visionPerception` call site, and parses the
 * model's response into `{ duration_s, segments, truncated? }`. When frames are
 * capped, `truncated` is populated so coverage is never silently overstated.
 *
 * Default export = the tool definition. `defaults/index.ts` finalizes it and
 * attaches it to the vision-perception plugin's `tools` array, which
 * `bootstrapPlugins` registers into the model-visible tool catalog.
 */

import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "@vellumai/plugin-api";
import { RiskLevel } from "@vellumai/plugin-api";

import {
  extractAllText,
  getConfiguredProvider,
} from "../../../../providers/provider-send-message.js";
import type { Message } from "../../../../providers/types.js";
import { parseModelJson } from "../src/coordinates.js";
import { resolveVisionVideo } from "../src/media-source.js";
import type {
  FramesTruncation,
  SampledFrame,
  SampleStrategy,
} from "../src/video-frames.js";

const VISION_CALL_SITE = "visionPerception" as const;

const SAMPLE_STRATEGIES: readonly SampleStrategy[] = [
  "keyframes",
  "uniform_1hz",
  "uniform_4hz",
];

interface VideoSegment {
  t_start: number;
  t_end: number;
  summary: string;
  events: string[];
}

interface VideoLog {
  duration_s: number;
  segments: VideoSegment[];
  truncated?: FramesTruncation;
}

const VIDEO_SYSTEM_PROMPT =
  "You are a vision assistant analyzing a video. You are given an ordered set of " +
  "frames sampled from the video, each labeled with its timestamp in seconds. " +
  "Reason only about what is actually visible across the frames; if something " +
  "cannot be determined from the frames, say so rather than guessing.";

function buildVideoPrompt(query: string, frameCount: number): string {
  const focus = query.trim()
    ? ` Focus the log on: ${query.trim()}.`
    : " Log everything notable that happens.";
  return (
    `You are given ${frameCount} timestamped frames from a video, in order.${focus} ` +
    "Produce a timestamped event log. Respond with ONLY a JSON object of the form " +
    '{"segments": [{"t_start": <seconds>, "t_end": <seconds>, ' +
    '"summary": "<what happens in this span>", "events": ["<discrete event>", ...]}]} ' +
    "where each segment covers a contiguous span and t_start/t_end are in seconds " +
    "drawn from the frame timestamps. Do not include any prose outside the JSON."
  );
}

/** Build the user message: each frame as `[t=Ns]` text label followed by its image. */
function buildFrameMessage(frames: SampledFrame[], query: string): Message {
  const content: Message["content"] = [];
  for (const frame of frames) {
    content.push({ type: "text", text: `[t=${frame.t_seconds}s]` });
    content.push(frame.block);
  }
  content.push({ type: "text", text: buildVideoPrompt(query, frames.length) });
  return { role: "user", content };
}

function toSeconds(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse the model's response into segments. Throws when the response isn't the
 * expected JSON so the tool can degrade to an error. Accepts either a
 * `{ segments: [...] }` object or a bare array of segments.
 */
function parseSegments(text: string): VideoSegment[] {
  const parsed = parseModelJson(text);
  let rawList: unknown;
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else if (parsed && typeof parsed === "object") {
    rawList = (parsed as Record<string, unknown>).segments;
  } else {
    throw new Error("vision model did not return a JSON video log");
  }
  if (!Array.isArray(rawList)) {
    throw new Error("vision model did not return a segments array");
  }

  const segments: VideoSegment[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const events = Array.isArray(obj.events)
      ? obj.events.filter((e): e is string => typeof e === "string")
      : [];
    segments.push({
      t_start: toSeconds(obj.t_start),
      t_end: toSeconds(obj.t_end),
      summary: typeof obj.summary === "string" ? obj.summary : "",
      events,
    });
  }
  return segments;
}

function parseWindow(raw: unknown): [number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) return undefined;
  const start = Number(raw[0]);
  const end = Number(raw[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return [start, end];
}

const vlmVideoLogTool: ToolDefinition = {
  name: "vlm_video_log",
  description:
    "Use whenever the user provides a video to read or summarize. Pass the " +
    "attachment id as media_ref. Samples timestamped keyframes and returns a " +
    "timestamped event log (segments with summaries and discrete events). " +
    "Optionally pass a query to focus the log, a sample strategy, or a " +
    "window [start_s, end_s] to restrict the span.",
  input_schema: {
    type: "object",
    properties: {
      media_ref: { type: "string" },
      query: { type: "string" },
      sample: {
        type: "string",
        enum: ["keyframes", "uniform_1hz", "uniform_4hz"],
      },
      window: {
        type: "array",
        items: { type: "number" },
        minItems: 2,
        maxItems: 2,
      },
    },
    required: ["media_ref"],
  },
  // Read-only video inspection; low risk so the call isn't gated behind a prompt.
  defaultRiskLevel: RiskLevel.Low,
  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    try {
      const mediaRef = String(input.media_ref ?? "");
      const query = typeof input.query === "string" ? input.query : "";
      const sample =
        typeof input.sample === "string" &&
        (SAMPLE_STRATEGIES as readonly string[]).includes(input.sample)
          ? (input.sample as SampleStrategy)
          : undefined;
      const window = parseWindow(input.window);

      const { video } = await resolveVisionVideo(mediaRef, {
        ...(sample ? { sample } : {}),
        ...(window ? { window } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      const provider = await getConfiguredProvider(VISION_CALL_SITE);
      if (!provider) {
        throw new Error("no vision inference provider is configured");
      }

      const message = buildFrameMessage(video.frames, query);
      const response = await provider.sendMessage([message], {
        systemPrompt: VIDEO_SYSTEM_PROMPT,
        config: { callSite: VISION_CALL_SITE },
        signal: ctx.signal,
      });

      const segments = parseSegments(extractAllText(response));
      const result: VideoLog = {
        duration_s: video.duration_s,
        segments,
        ...(video.truncated ? { truncated: video.truncated } : {}),
      };

      return { content: JSON.stringify(result), isError: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { content: reason, isError: true };
    }
  },
};

export default vlmVideoLogTool;

/**
 * The `vlm_detect` tool — locates objects in a provided image, returning each
 * detection as a normalized bounding box.
 *
 * The model passes the image's attachment id as `media_ref` and optionally a
 * list of `targets` to look for (otherwise all salient objects). The plugin asks
 * the vision model for detections as JSON, parses that response, normalizes each
 * box onto the 0–1000 grounding contract, and echoes the image's pixel
 * `image_size`.
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

import { callVisionModelWithBlock } from "../src/call-vision-model.js";
import {
  type BBox,
  type ImageSize,
  imageSizeFromBlock,
  normalizeBox,
  parseModelJson,
} from "../src/coordinates.js";
import { resolveVisionMedia } from "../src/media-source.js";

interface Detection {
  label: string;
  bbox: BBox;
  confidence: number | null;
}

interface DetectResult {
  detections: Detection[];
  image_size: ImageSize;
}

function buildDetectPrompt(targets: string[]): string {
  const what =
    targets.length > 0
      ? `Detect the following objects in this image: ${targets.join(", ")}.`
      : "Detect all salient objects in this image.";
  return (
    `${what} Respond with ONLY a JSON object of the form ` +
    '{"detections": [{"label": "<object name>", "bbox": [x0, y0, x1, y1], ' +
    '"confidence": <0..1>}]} where each bbox is the object\'s bounding box on a ' +
    "0-1000 scale relative to the image. Omit objects you cannot find. Do not " +
    "include any prose outside the JSON."
  );
}

function toConfidence(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the model's response into detections. Throws when the response isn't the
 * expected JSON so the tool can degrade to an error. Accepts either a
 * `{ detections: [...] }` object or a bare array of detections.
 */
function parseDetections(text: string, imageSize: ImageSize): DetectResult {
  const parsed = parseModelJson(text);
  let rawList: unknown;
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else if (parsed && typeof parsed === "object") {
    rawList = (parsed as Record<string, unknown>).detections;
  } else {
    throw new Error("vision model did not return JSON detections");
  }
  if (!Array.isArray(rawList)) {
    throw new Error("vision model did not return a detections array");
  }

  const detections: Detection[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const bbox = normalizeBox(obj.bbox);
    if (!bbox) continue;
    detections.push({
      label: typeof obj.label === "string" ? obj.label : "",
      bbox,
      confidence: toConfidence(obj.confidence),
    });
  }

  return { detections, image_size: imageSize };
}

const vlmDetectTool: ToolDefinition = {
  name: "vlm_detect",
  description:
    "Use to locate objects in a provided image and get their bounding boxes. " +
    "Pass the attachment id as media_ref; optionally pass targets to detect " +
    "specific objects. Boxes are returned on a 0-1000 scale with the image size.",
  input_schema: {
    type: "object",
    properties: {
      media_ref: { type: "string" },
      targets: { type: "array", items: { type: "string" } },
    },
    required: ["media_ref"],
  },
  // Read-only image inspection; low risk so the call isn't gated behind a prompt.
  defaultRiskLevel: RiskLevel.Low,
  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    try {
      const mediaRef = String(input.media_ref ?? "");
      const targets = Array.isArray(input.targets)
        ? input.targets.filter((t): t is string => typeof t === "string")
        : [];

      const media = await resolveVisionMedia(mediaRef, ctx.conversationId);
      const imageSize = imageSizeFromBlock(media.block, media.mimeType);
      const prompt = buildDetectPrompt(targets);
      const answer = await callVisionModelWithBlock(media.block, prompt, ctx);

      const result = parseDetections(answer, imageSize);
      return { content: JSON.stringify(result), isError: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { content: reason, isError: true };
    }
  },
};

export default vlmDetectTool;

/**
 * The `vlm_ocr` tool — extracts text from a provided image.
 *
 * The model passes the image's attachment id as `media_ref`, optionally narrows
 * to a `region`, and sets `layout` to also recover positioned text blocks. The
 * plugin asks the vision model to extract the text (returning JSON when `layout`
 * is on), parses that response, normalizes any block boxes onto the 0–1000
 * grounding contract, and echoes the image's pixel `image_size`.
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

interface OcrBlock {
  text: string;
  bbox: BBox;
}

interface OcrResult {
  full_text: string;
  blocks?: OcrBlock[];
  image_size: ImageSize;
}

function buildOcrPrompt(region: BBox | null, layout: boolean): string {
  const lens = region
    ? ` Only read text inside the region [x0,y0,x1,y1]=[${region.join(", ")}] ` +
      "given on a 0-1000 scale relative to the image."
    : "";
  if (layout) {
    return (
      `Extract all readable text from this image.${lens} ` +
      "Respond with ONLY a JSON object of the form " +
      '{"full_text": "<all text joined in reading order>", ' +
      '"blocks": [{"text": "<text of this block>", "bbox": [x0, y0, x1, y1]}]} ' +
      "where each bbox is the block's bounding box on a 0-1000 scale relative " +
      "to the image. Do not include any prose outside the JSON."
    );
  }
  return (
    `Extract all readable text from this image.${lens} ` +
    "Return only the transcribed text, in natural reading order, with no commentary."
  );
}

/**
 * Parse the model's `layout` response into positioned blocks. Throws when the
 * response isn't the expected JSON object so the tool can degrade to an error.
 * Blocks whose `bbox` isn't four actual finite numbers are dropped rather than
 * fabricated as a zero box (the model sometimes emits placeholder/uncertain
 * coordinates like `null` or empty strings).
 */
function parseLayout(text: string, imageSize: ImageSize): OcrResult {
  const parsed = parseModelJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("vision model did not return a JSON OCR object");
  }
  const obj = parsed as Record<string, unknown>;
  const rawBlocks = Array.isArray(obj.blocks) ? obj.blocks : [];
  const blocks: OcrBlock[] = [];
  for (const b of rawBlocks) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    const bbox = normalizeBox(block.bbox);
    if (!bbox) continue;
    blocks.push({
      text: typeof block.text === "string" ? block.text : "",
      bbox,
    });
  }
  const fullText =
    typeof obj.full_text === "string"
      ? obj.full_text
      : blocks.map((b) => b.text).join("\n");
  return { full_text: fullText, blocks, image_size: imageSize };
}

const vlmOcrTool: ToolDefinition = {
  name: "vlm_ocr",
  description:
    "Use to extract (OCR) the text from a provided image. Pass the attachment " +
    "id as media_ref. Set layout=true to also get the text broken into " +
    "positioned blocks with bounding boxes.",
  input_schema: {
    type: "object",
    properties: {
      media_ref: { type: "string" },
      region: { type: "array", items: { type: "number" } },
      layout: { type: "boolean" },
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
      const region = normalizeBox(input.region);
      const layout = input.layout === true;

      const media = await resolveVisionMedia(mediaRef, ctx.conversationId);
      const imageSize = imageSizeFromBlock(media.block, media.mimeType);
      const prompt = buildOcrPrompt(region, layout);
      const answer = await callVisionModelWithBlock(media.block, prompt, ctx);

      const result: OcrResult = layout
        ? parseLayout(answer, imageSize)
        : { full_text: answer, image_size: imageSize };

      return { content: JSON.stringify(result), isError: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { content: reason, isError: true };
    }
  },
};

export default vlmOcrTool;

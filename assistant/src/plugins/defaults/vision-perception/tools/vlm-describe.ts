/**
 * The `vlm_describe` tool — returns a structured description of a provided
 * image.
 *
 * The model passes the image's attachment id as `media_ref`, optionally
 * narrowing the description with `focus` and choosing a `detail` level; the
 * plugin resolves the attachment and sends the image plus a description prompt
 * to the vision call site.
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

import { callVisionModel } from "../src/call-vision-model.js";

const DETAIL_GUIDANCE: Record<string, string> = {
  brief: "Give a one- to two-sentence summary of the image.",
  standard:
    "Give a clear paragraph describing the salient contents of the image.",
  exhaustive:
    "Give an exhaustive description covering every notable element, " +
    "any visible text, layout, colors, and spatial relationships.",
};

function buildDescribePrompt(focus: string, detail: string): string {
  const level = DETAIL_GUIDANCE[detail] ?? DETAIL_GUIDANCE.standard;
  const lens = focus.trim()
    ? ` Focus your description on: ${focus.trim()}.`
    : "";
  return `Describe this image.${lens} ${level}`;
}

const vlmDescribeTool: ToolDefinition = {
  name: "vlm_describe",
  description:
    "Use to get a structured description of a provided image when you don't yet " +
    "know what to ask.",
  input_schema: {
    type: "object",
    properties: {
      media_ref: { type: "string" },
      focus: { type: "string" },
      detail: { type: "string", enum: ["brief", "standard", "exhaustive"] },
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
      const focus = typeof input.focus === "string" ? input.focus : "";
      const detail =
        typeof input.detail === "string" ? input.detail : "standard";
      const prompt = buildDescribePrompt(focus, detail);
      const content = await callVisionModel(mediaRef, prompt, ctx);
      return { content, isError: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { content: reason, isError: true };
    }
  },
};

export default vlmDescribeTool;

/**
 * The `vlm_ask` tool — reads a provided image and answers a question about it.
 *
 * The model passes the image's attachment id as `media_ref` and a `question`;
 * the plugin resolves the attachment, sends the image plus question to the
 * vision call site, and returns the model's answer.
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

const vlmAskTool: ToolDefinition = {
  name: "vlm_ask",
  description:
    "Use this whenever the user provides an image to read or answer questions about it. " +
    "Pass the attachment id as media_ref.",
  input_schema: {
    type: "object",
    properties: {
      media_ref: { type: "string" },
      question: { type: "string" },
      region: { type: "array", items: { type: "number" } },
    },
    required: ["media_ref", "question"],
  },
  // Read-only image inspection; low risk so the call isn't gated behind a prompt.
  defaultRiskLevel: RiskLevel.Low,
  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    try {
      const mediaRef = String(input.media_ref ?? "");
      const question = String(input.question ?? "");
      const content = await callVisionModel(mediaRef, question, ctx);
      return { content, isError: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { content: reason, isError: true };
    }
  },
};

export default vlmAskTool;

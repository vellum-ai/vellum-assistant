/**
 * Run one vision-perception call.
 *
 * Routed entirely through the assistant's own inference: `getConfiguredProvider`
 * resolves the `visionPerception` call site (flag-gated to a vision-capable
 * inference profile) to a provider/model/credentials from the configured
 * profiles — managed-proxy or BYOK, no separate API key. The media reference is
 * resolved to an `ImageContent` block, paired with the prompt as a single user
 * `Message`, and sent through `provider.sendMessage`; the returned text blocks
 * are concatenated into the answer.
 */

import {
  extractAllText,
  getConfiguredProvider,
} from "../../../../providers/provider-send-message.js";
import type { Message } from "../../../../providers/types.js";
import type { ToolContext } from "../../../../tools/types.js";
import { resolveVisionMedia } from "./media-source.js";

// Dedicated vision call site. Its profile (a vision-capable model) is resolved
// by the LLM config layer when the `vision-perception` feature flag is on.
const VISION_CALL_SITE = "visionPerception" as const;

/**
 * Resolve the media reference, send the image + prompt to the vision call site,
 * and return the model's text answer. Throws when no vision provider is
 * configured; media-resolution failures throw {@link VisionMediaError}.
 */
export async function callVisionModel(
  mediaRef: string,
  prompt: string,
  ctx: ToolContext,
): Promise<string> {
  const media = await resolveVisionMedia(mediaRef);

  const provider = await getConfiguredProvider(VISION_CALL_SITE);
  if (!provider) {
    throw new Error("no vision inference provider is configured");
  }

  const message: Message = {
    role: "user",
    content: [media.block, { type: "text", text: prompt }],
  };

  const response = await provider.sendMessage([message], {
    systemPrompt: VISION_SYSTEM_PROMPT,
    config: { callSite: VISION_CALL_SITE },
    signal: ctx.signal,
  });

  const answer = extractAllText(response).trim();
  return answer.length > 0 ? answer : "(vision model returned no text)";
}

const VISION_SYSTEM_PROMPT =
  "You are a vision assistant. Examine the provided image carefully and respond " +
  "to the request precisely. Report only what is actually visible; if something " +
  "cannot be determined from the image, say so rather than guessing.";

/**
 * Run one vision-perception call.
 *
 * Routed entirely through the assistant's own inference: `getConfiguredProvider`
 * resolves the `visionPerception` call site (flag-gated to a vision-capable
 * inference profile) to a provider/model/credentials from the configured
 * profiles — managed-proxy or BYOK, no separate API key. A prebuilt message
 * content array is paired with a system prompt as a single user `Message` and
 * sent through `provider.sendMessage`; the returned text blocks are concatenated
 * into the answer.
 *
 * {@link sendVisionMessage} is the single source for the call-site const,
 * provider resolution, send, and text extraction. {@link callVisionModel} and
 * {@link callVisionModelWithBlock} are thin helpers over it: the former resolves
 * a media reference into an image block first; the latter reuses an
 * already-resolved block so a caller that also needs the image's pixel size
 * resolves the media only once.
 */

import {
  extractAllText,
  getConfiguredProvider,
} from "../../../../providers/provider-send-message.js";
import type { ImageContent, Message } from "../../../../providers/types.js";
import type { ToolContext } from "../../../../tools/types.js";
import { resolveVisionMedia } from "./media-source.js";

// Dedicated vision call site. Its profile (a vision-capable model) is resolved
// by the LLM config layer when the `vision-perception` feature flag is on.
const VISION_CALL_SITE = "visionPerception" as const;

const VISION_SYSTEM_PROMPT =
  "You are a vision assistant. Examine the provided image carefully and respond " +
  "to the request precisely. Report only what is actually visible; if something " +
  "cannot be determined from the image, say so rather than guessing.";

/**
 * Send a prebuilt user-message content array to the vision call site and return
 * the model's text answer. Resolves the provider, sends a single user message,
 * and concatenates the returned text blocks. Throws when no vision provider is
 * configured.
 */
export async function sendVisionMessage(
  content: Message["content"],
  systemPrompt: string,
  ctx: ToolContext,
): Promise<string> {
  const provider = await getConfiguredProvider(VISION_CALL_SITE);
  if (!provider) {
    throw new Error("no vision inference provider is configured");
  }

  const message: Message = { role: "user", content };
  const response = await provider.sendMessage([message], {
    systemPrompt,
    config: { callSite: VISION_CALL_SITE },
    signal: ctx.signal,
  });

  return extractAllText(response);
}

/**
 * Send an already-resolved image block plus a prompt to the vision call site and
 * return the model's text answer. Lets a caller that already resolved the media
 * (e.g. to derive its pixel size) reuse the block instead of resolving twice.
 * Throws when no vision provider is configured.
 */
export async function callVisionModelWithBlock(
  block: ImageContent,
  prompt: string,
  ctx: ToolContext,
): Promise<string> {
  const answer = (
    await sendVisionMessage(
      [block, { type: "text", text: prompt }],
      VISION_SYSTEM_PROMPT,
      ctx,
    )
  ).trim();
  return answer.length > 0 ? answer : "(vision model returned no text)";
}

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
  return callVisionModelWithBlock(media.block, prompt, ctx);
}

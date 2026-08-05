/**
 * Host-side media-capability guard for the agent loop's final send boundary.
 *
 * The image-fallback plugin's `pre-model-call` hook is the proactive quality
 * pass (captioning via a vision profile when one exists), but the plugin
 * pipeline discards a hook's mutation when it throws or times out, and a hook
 * registered later in the chain can reroute the call to a text-only profile
 * after the guard has passed. The loop therefore enforces the invariant
 * itself, immediately before provider send: raw image blocks must not reach a
 * model that cannot accept them.
 *
 * This module lives in host code (not the plugin) deliberately: the loop may
 * not reach into a plugin's internals (see
 * `plugin-import-boundary-reverse-guard.test.ts`), and the guarantee must
 * hold even with the plugin disabled or replaced. The substitution here is
 * intentionally dumber than the plugin's: static placeholder text only, no
 * captioning, no persistence, no provider calls. The plugin remains the
 * quality pass; this is the backstop.
 *
 * The placeholder text matches the plugin's no-vision-profile placeholder so
 * downstream consumers (and tests) observe one consistent degraded form
 * regardless of which layer substituted it.
 */

import { getModelProfiles } from "../plugin-api/model-profiles.js";
import { doesSupportVision } from "../plugin-api/vision-support.js";
import type { ContentBlock, Message } from "../providers/types.js";

/**
 * Text substituted for an image block that cannot be captioned. Kept
 * byte-identical to the image-fallback plugin's no-vision placeholder (its
 * `captionImageBlocks` null-profile branch) so both layers degrade to the
 * same observable form.
 */
export const NO_VISION_PLACEHOLDER_TEXT =
  "[Image: no vision-capable model configured to describe it]";

/**
 * Whether the model identity a call will actually run under lacks vision
 * support. Mirrors the plugin's `needsImageFallback`: resolve a profile key
 * through the configured profiles first, and fall back to treating the key
 * as a concrete model id for profileless configs.
 */
export function modelLacksVisionSupport(modelProfileKey: string): boolean {
  const profile = getModelProfiles().find((p) => p.key === modelProfileKey);
  if (profile == null) {
    return !doesSupportVision(modelProfileKey);
  }
  return !doesSupportVision(profile);
}

/**
 * Replace every image block in `messages` (in place) with the static
 * placeholder text block: top-level image blocks and images nested in
 * `tool_result` `contentBlocks`. Returns the number of blocks replaced.
 *
 * Callers own the wire-only contract: pass a clone, never the loop's history.
 * The walk is deliberately exhaustive rather than mirroring the plugin
 * sweep's current-turn scoping. The boundary runs on the sanitized outbound
 * payload, where stale tool-result media has already been stripped to
 * markers, so anything image-shaped that remains was about to go on the wire
 * and a text-only model can do nothing with any of it.
 */
export function replaceOutboundImagesWithPlaceholders(
  messages: Message[],
): number {
  let replaced = 0;
  const substitute = (blocks: ContentBlock[]): void => {
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].type === "image") {
        blocks[i] = { type: "text", text: NO_VISION_PLACEHOLDER_TEXT };
        replaced++;
      }
    }
  };
  for (const message of messages) {
    substitute(message.content);
    for (const block of message.content) {
      if (block.type === "tool_result" && block.contentBlocks != null) {
        substitute(block.contentBlocks);
      }
    }
  }
  return replaced;
}

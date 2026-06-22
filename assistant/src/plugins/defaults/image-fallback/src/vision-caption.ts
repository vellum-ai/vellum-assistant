/**
 * Vision-based image captioning for the image-fallback plugin.
 *
 * When the active model cannot process images, this module finds a
 * vision-capable profile in the workspace's configured profiles and runs a
 * one-shot captioning call through the assistant's own inference (no
 * plugin-supplied API key). The caption replaces the image block in the
 * outgoing message history.
 */

import {
  doesSupportVision,
  getConfiguredModelId,
  getConfiguredProvider,
  getModelProfiles,
  type ImageContent,
  type PluginLogger,
} from "@vellumai/plugin-api";

import { extractAllText } from "../../../../providers/provider-send-message.js";
import {
  getCachedCaption,
  imageHash,
  setCachedCaption,
} from "./caption-cache.js";

const CAPTION_TIMEOUT_MS = 30_000;

const CAPTION_SYSTEM_PROMPT =
  "You are a vision assistant. Describe the image concisely in 1-2 sentences. " +
  "Focus on the key visual content, text, charts, or UI elements that would be " +
  "relevant for a text-based assistant to understand and reason about.";

const CAPTION_USER_PROMPT = "Describe this image concisely for a text-only assistant.";

/**
 * Find a vision-capable, enabled profile key for captioning.
 *
 * Scans the workspace's profiles in `getModelProfiles()` order (the same order
 * the `/model` picker shows them) and returns the first enabled profile that:
 *   1. has a different key than `activeProfileKey` (when provided), AND
 *   2. `doesSupportVision` reports as vision-capable, AND
 *   3. resolves to a `(provider, model)` tuple different from the active
 *      profile's resolved `(provider, model)`.
 *
 * Returns `null` when no such profile exists — the hook fails-open in that
 * case, leaving a placeholder text block.
 *
 * Condition 3 is the belt-and-suspenders against the bug where two
 * different profile keys resolve to the same text-only model (e.g. `os-beta`
 * and `auto` both → fireworks / glm-5p2). `doesSupportVision` may return
 * `true` for the candidate due to a catalog miss — `vision-support.ts` is
 * fail-open (`catalogModel?.supportsVision ?? true`), so we cross-check by
 * resolving the candidate's `(provider, model)` and comparing against the
 * active profile's. The comparison must include the model id, not just the
 * provider name, because two profiles sharing a provider can legitimately
 * use different models (e.g. `os-beta → fireworks / glm-5p2` and
 * `balanced → fireworks / minimax-m3`) — only the model id distinguishes
 * text-only from vision-capable under the same provider. The cost is one
 * extra config resolution per candidate, no LLM traffic.
 *
 * `getConfiguredModelId` and `getConfiguredProvider` are thin async wrappers
 * around `resolveConfiguredProvider` that load credentials and instantiate
 * the provider — they do NOT make any LLM request.
 */
export async function findVisionProfile(
  activeProfileKey?: string | null,
): Promise<string | null> {
  // Resolve the active profile's (provider, model) once so each candidate's
  // resolution can be compared against it. Catch any resolution failure so
  // a transient config issue does not take the whole caption path offline.
  let activeIdentity: { provider: string; model: string } | null = null;
  if (activeProfileKey != null) {
    const [activeProvider, activeModel] = await Promise.all([
      getConfiguredProvider("vision", {
        overrideProfile: activeProfileKey,
        forceOverrideProfile: true,
      }).catch(() => null),
      getConfiguredModelId("vision", {
        overrideProfile: activeProfileKey,
        forceOverrideProfile: true,
      }).catch(() => null),
    ]);
    if (activeProvider?.name != null && activeModel != null) {
      activeIdentity = { provider: activeProvider.name, model: activeModel };
    }
  }

  for (const profile of getModelProfiles()) {
    if (profile.isDisabled) continue;
    if (activeProfileKey != null && profile.key === activeProfileKey) continue;
    if (!doesSupportVision(profile)) continue;

    // Skip candidates whose resolved (provider, model) matches the active
    // profile's. Without this guard, a misconfigured workspace (catalog miss
    // on the candidate model) would route the caption call back to the same
    // text-only model the hook is trying to caption around. We compare on
    // both fields: a candidate sharing the active's PROVIDER but with a
    // different MODEL (e.g. balanced → fireworks/minimax-m3 vs os-beta →
    // fireworks/glm-5p2) is a legitimate vision-capable fallback.
    if (activeIdentity != null) {
      const [candidateProvider, candidateModel] = await Promise.all([
        getConfiguredProvider("vision", {
          overrideProfile: profile.key,
          forceOverrideProfile: true,
        }).catch(() => null),
        getConfiguredModelId("vision", {
          overrideProfile: profile.key,
          forceOverrideProfile: true,
        }).catch(() => null),
      ]);
      if (
        candidateProvider?.name === activeIdentity.provider &&
        candidateModel === activeIdentity.model
      ) {
        continue;
      }
    }

    return profile.key;
  }
  return null;
}

/**
 * Caption a single image block via a vision-capable profile.
 *
 * @param image     The image content block to caption.
 * @param profileKey  Key of a vision-capable profile (from {@link findVisionProfile}).
 * @param logger    Turn-scoped logger for attribution.
 * @returns The caption text, or `null` when captioning failed (caller should
 *          use a fail-open placeholder).
 */
export async function captionImage(
  image: ImageContent,
  profileKey: string,
  logger: PluginLogger,
): Promise<string | null> {
  const hash = imageHash(image.source.data);
  const cached = getCachedCaption(hash);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const provider = await getConfiguredProvider("vision", {
      overrideProfile: profileKey,
      forceOverrideProfile: true,
    });
    if (!provider) {
      logger.warn(
        { plugin: "image-fallback" },
        "No provider resolved for vision captioning profile",
      );
      return null;
    }

    const response = await provider.sendMessage(
      [
        {
          role: "user",
          content: [image, { type: "text", text: CAPTION_USER_PROMPT }],
        },
      ],
      {
        systemPrompt: CAPTION_SYSTEM_PROMPT,
        config: {
          callSite: "vision",
          overrideProfile: profileKey,
          forceOverrideProfile: true,
          tool_choice: { type: "none" },
        },
        signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
      },
    );

    const caption = extractAllText(response).trim();
    if (caption.length > 0) {
      setCachedCaption(hash, caption);
      return caption;
    }

    logger.warn({ plugin: "image-fallback" }, "Vision captioning returned empty text");
    return null;
  } catch (err) {
    logger.warn(
      { plugin: "image-fallback", err },
      "Vision captioning call failed",
    );
    return null;
  }
}

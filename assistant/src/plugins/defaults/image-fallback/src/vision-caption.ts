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
  getConfiguredProvider,
  getModelProfiles,
  type ImageContent,
  type PluginLogger,
  type Provider,
  resolveMediaSourceData,
} from "@vellumai/plugin-api";

import {
  getCachedCaption,
  imageHash,
  setCachedCaption,
} from "./caption-cache.js";

/**
 * Time-box for the vision caption request. Kept below the 30s plugin hook
 * time-box so a timed-out caption still substitutes prompt text rather than
 * discarding the whole hook.
 */
export const CAPTION_TIMEOUT_MS = 25_000;

export type CaptionResult =
  | { status: "caption"; text: string }
  | { status: "timeout" }
  | { status: "failed" };

const CAPTION_SYSTEM_PROMPT =
  "You are a vision assistant. Describe the image concisely in 1-2 sentences. " +
  "Focus on the key visual content, text, charts, or UI elements that would be " +
  "relevant for a text-based assistant to understand and reason about.";

const CAPTION_USER_PROMPT =
  "Describe this image concisely for a text-only assistant.";

/**
 * Find a vision-capable, enabled profile key for captioning.
 *
 * Scans the workspace's profiles in `getModelProfiles()` order (the same order
 * the `/model` picker shows them) and returns the first enabled profile whose
 * resolved model supports vision. Returns `null` when no vision profile exists
 * — the hook fails-open in that case, leaving a placeholder text block.
 */
export function findVisionProfile(): string | null {
  for (const profile of getModelProfiles()) {
    if (profile.isDisabled) {
      continue;
    }
    if (doesSupportVision(profile)) {
      return profile.key;
    }
  }
  return null;
}

/**
 * Caption a single image block via a vision-capable profile.
 *
 * @param image     The image content block to caption.
 * @param conversationId  Conversation the image belongs to, recorded on the
 *          cache row so `conversation-deleted` cleanup stays accurate.
 * @param profileKey  Key of a vision-capable profile (from {@link findVisionProfile}).
 * @param logger    Turn-scoped logger for attribution.
 * @returns A caption, a timeout marker, or `failed` when captioning could
 *          not run (caller substitutes fail-open prompt text).
 */
export async function captionImage(
  image: ImageContent,
  conversationId: string,
  profileKey: string,
  logger: PluginLogger,
): Promise<CaptionResult> {
  // Hash the image's content (resolving a reference source to its bytes, a
  // no-op for inline base64) so the caption cache keys on the image itself.
  const resolved = resolveMediaSourceData(image.source);
  if (!resolved) {
    return { status: "failed" };
  }
  const hash = imageHash(resolved.data);
  const cached = getCachedCaption(hash, conversationId);
  if (cached !== undefined) {
    return { status: "caption", text: cached };
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
      return { status: "failed" };
    }

    const response = await sendCaptionRequest(provider, {
      image,
      conversationId,
      profileKey,
    });

    // Vision captioning returns text content; concatenate any text blocks
    // (effectively always one here, since tool use is disabled).
    const caption = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(" ")
      .trim();
    if (caption.length > 0) {
      setCachedCaption(hash, conversationId, caption);
      return { status: "caption", text: caption };
    }

    logger.warn(
      { plugin: "image-fallback" },
      "Vision captioning returned empty text",
    );
    return { status: "failed" };
  } catch (err) {
    if (isCaptionTimeoutError(err)) {
      logger.warn(
        { plugin: "image-fallback", err, profileKey },
        "Vision captioning timed out",
      );
      return { status: "timeout" };
    }
    logger.warn(
      { plugin: "image-fallback", err },
      "Vision captioning call failed",
    );
    return { status: "failed" };
  }
}

/**
 * Label of the vision profile used for captioning, for timeout prompt text.
 */
export function visionProfileLabel(profileKey: string): string {
  const profile = getModelProfiles().find((p) => p.key === profileKey);
  return profile?.label ?? profileKey;
}

function isCaptionTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.name === "TimeoutError" ||
    err.name === "AbortError" ||
    err.name === "APIUserAbortError"
  );
}

/**
 * Time-box the vision `sendMessage` call itself: abort the request at
 * {@link CAPTION_TIMEOUT_MS}, and settle on that deadline even if the provider
 * ignores the abort signal.
 */
async function sendCaptionRequest(
  provider: Provider,
  args: {
    image: ImageContent;
    conversationId: string;
    profileKey: string;
  },
): Promise<Awaited<ReturnType<Provider["sendMessage"]>>> {
  const signal = AbortSignal.timeout(CAPTION_TIMEOUT_MS);
  const timedOut = new Promise<never>((_, reject) => {
    const rejectTimedOut = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation timed out", "TimeoutError"),
      );
    };
    if (signal.aborted) {
      rejectTimedOut();
      return;
    }
    signal.addEventListener("abort", rejectTimedOut, { once: true });
  });
  // Absorb whichever side loses the race so a late abort or late response
  // does not become an unhandled rejection.
  timedOut.catch(() => {});
  const work = provider.sendMessage(
    [
      {
        role: "user",
        content: [args.image, { type: "text", text: CAPTION_USER_PROMPT }],
      },
    ],
    {
      systemPrompt: CAPTION_SYSTEM_PROMPT,
      config: {
        callSite: "vision",
        conversationId: args.conversationId,
        overrideProfile: args.profileKey,
        forceOverrideProfile: true,
        tool_choice: { type: "none" },
      },
      signal,
    },
  );
  work.catch(() => {});
  return await Promise.race([work, timedOut]);
}

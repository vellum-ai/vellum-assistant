/**
 * Vision calls for the image-fallback plugin.
 *
 * When the active model cannot process images, this module finds a
 * vision-capable profile in the workspace's configured profiles
 * ({@link findVisionProfile}) and runs one-shot calls against it through the
 * assistant's own inference (no plugin-supplied API key).
 *
 * Two callers sit on the shared call ({@link describeImage}): the sweep's
 * fixed-prompt caption ({@link captionImage}, cached by content hash) that
 * replaces the image block in the outgoing history, and the `image_ask` tool's
 * question about one image, whose answers are turn-specific and are not
 * cached.
 */

import {
  doesSupportVision,
  getConfiguredProvider,
  getModelProfiles,
  type ImageContent,
  type PluginLogger,
  resolveMediaSourceData,
} from "@vellumai/plugin-api";

import {
  getCachedCaption,
  imageHash,
  setCachedCaption,
} from "./caption-cache.js";

const CAPTION_TIMEOUT_MS = 30_000;

const CAPTION_SYSTEM_PROMPT =
  "You are a vision assistant. Describe the image concisely in 1-2 sentences. " +
  "Focus on the key visual content, text, charts, or UI elements that would be " +
  "relevant for a text-based assistant to understand and reason about. " +
  "Describe only what is visible: quote any text or numbers exactly as they " +
  "are printed, and do not guess at, complete, or interpret what the image " +
  "does not show.";

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

/** One vision call's prompts and limits. */
export interface DescribeImageRequest {
  /** System prompt framing what the vision model is being asked for. */
  systemPrompt: string;
  /** User-turn text sent alongside the image. */
  userPrompt: string;
  /** Response cap, defaulting to whatever the `vision` call site resolves. */
  maxTokens?: number;
  /** Wall-clock cap on the call. Defaults to {@link CAPTION_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Caller's cancellation, honored alongside the timeout. */
  signal?: AbortSignal;
}

/**
 * Run one vision call over an image and return its text.
 *
 * The shared provider path behind every look the plugin takes at an image:
 * {@link captionImage}'s fixed-prompt caption and the `image_ask` tool's
 * question both land here, so the profile selection, timeout, tool-free
 * request shape, and text extraction have one implementation.
 *
 * Tool use is disabled on the call, so the response is text; the answer is
 * whatever text blocks it carries, joined. Returns `null` on a failed or
 * empty call — callers decide what to show instead, and nothing throws out of
 * here.
 *
 * @param image      The image content block to send.
 * @param conversationId  Conversation the call is attributed to.
 * @param profileKey Key of a vision-capable profile (from {@link findVisionProfile}).
 * @param request    Prompts and limits for this call.
 * @param logger     Turn-scoped logger for attribution, when the caller has
 *                   one. Tool calls do not.
 */
export async function describeImage(
  image: ImageContent,
  conversationId: string,
  profileKey: string,
  request: DescribeImageRequest,
  logger?: PluginLogger | null,
): Promise<string | null> {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? CAPTION_TIMEOUT_MS);
  const signal =
    request.signal != null
      ? AbortSignal.any([request.signal, timeout])
      : timeout;

  try {
    const provider = await getConfiguredProvider("vision", {
      overrideProfile: profileKey,
      forceOverrideProfile: true,
    });
    if (!provider) {
      logger?.warn(
        { plugin: "image-fallback" },
        "No provider resolved for vision profile",
      );
      return null;
    }

    const response = await provider.sendMessage(
      [
        {
          role: "user",
          content: [image, { type: "text", text: request.userPrompt }],
        },
      ],
      {
        systemPrompt: request.systemPrompt,
        config: {
          callSite: "vision",
          conversationId,
          overrideProfile: profileKey,
          forceOverrideProfile: true,
          tool_choice: { type: "none" },
          ...(request.maxTokens != null
            ? { max_tokens: request.maxTokens }
            : {}),
        },
        signal,
      },
    );

    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(" ")
      .trim();
    if (text.length > 0) {
      return text;
    }

    logger?.warn({ plugin: "image-fallback" }, "Vision call returned no text");
    return null;
  } catch (err) {
    logger?.warn({ plugin: "image-fallback", err }, "Vision call failed");
    return null;
  }
}

/**
 * Caption a single image block via a vision-capable profile.
 *
 * @param image     The image content block to caption.
 * @param conversationId  Conversation the image belongs to, recorded on the
 *          cache row so `conversation-deleted` cleanup stays accurate.
 * @param profileKey  Key of a vision-capable profile (from {@link findVisionProfile}).
 * @param logger    Turn-scoped logger for attribution.
 * @returns The caption text, or `null` when captioning failed (caller should
 *          use a fail-open placeholder).
 */
export async function captionImage(
  image: ImageContent,
  conversationId: string,
  profileKey: string,
  logger: PluginLogger,
): Promise<string | null> {
  // Hash the image's content (resolving a reference source to its bytes, a
  // no-op for inline base64) so the caption cache keys on the image itself.
  const resolved = resolveMediaSourceData(image.source);
  if (!resolved) {
    return null;
  }
  const hash = imageHash(resolved.data);
  const cached = getCachedCaption(hash, conversationId);
  if (cached !== undefined) {
    return cached;
  }

  const caption = await describeImage(
    image,
    conversationId,
    profileKey,
    {
      systemPrompt: CAPTION_SYSTEM_PROMPT,
      userPrompt: CAPTION_USER_PROMPT,
    },
    logger,
  );
  if (caption == null) {
    return null;
  }
  setCachedCaption(hash, conversationId, caption);
  return caption;
}

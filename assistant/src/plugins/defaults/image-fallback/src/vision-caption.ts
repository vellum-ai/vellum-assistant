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
  getProfileInputTokenPrice,
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

const CAPTION_TIMEOUT_MS = 30_000;

const CAPTION_SYSTEM_PROMPT =
  "You are a vision assistant. Describe the image concisely in 1-2 sentences. " +
  "Focus on the key visual content, text, charts, or UI elements that would be " +
  "relevant for a text-based assistant to understand and reason about.";

const CAPTION_USER_PROMPT =
  "Describe this image concisely for a text-only assistant.";

/** A vision-capable profile whose provider resolved and is ready to caption. */
export interface ResolvedVisionProvider {
  /** Key of the vision-capable profile the provider was resolved for. */
  profileKey: string;
  /** Provider handle bound to that profile via the `vision` call site. */
  provider: Provider;
}

/**
 * Rank-then-try vision provider selection, scoped to a single sweep.
 *
 * {@link hasCandidates} answers the cheap, synchronous question "does any
 * enabled vision-capable profile exist to attempt captioning?" so the caller
 * can distinguish "no vision model configured" from "captioning failed" without
 * resolving a provider. {@link resolve} walks the ranked candidates cheapest
 * first and returns the first one whose provider actually resolves — so a
 * cheapest profile that resolves to `null` (dangling connection, unavailable
 * credential) or that *throws* a hard config error (missing/mismatched
 * `provider_connection`) falls through to the next usable one rather than
 * silently breaking captioning. Resolution is lazy (never runs for an
 * all-cache-hit sweep) and memoized (one resolution per sweep, reused across
 * every image).
 */
export interface VisionProviderResolver {
  /** Whether any enabled vision-capable profile exists to caption with. */
  hasCandidates(): boolean;
  /**
   * The first usable vision provider in cheapest-first order, or `null` when no
   * candidate resolves. A candidate that throws during resolution is treated
   * exactly like a `null` resolution — logged and skipped — so `resolve()`
   * never rejects; it settles to `null` only after every candidate is
   * exhausted. Resolves lazily on first call and memoizes the settled result
   * for the rest of the sweep.
   */
  resolve(): Promise<ResolvedVisionProvider | null>;
}

/**
 * Rank enabled, vision-capable profile keys cheapest first for captioning.
 *
 * Collects every enabled profile whose resolved model supports vision, in
 * `getModelProfiles()` order (the order the `/model` picker shows them), then
 * sorts by the resolved model's input-token price ascending. Any vision model
 * captions a 1-2 sentence description adequately, so cost is the tiebreak.
 * Profiles the catalog can't price rank after all priced ones, and equal prices
 * keep picker order — so a single vision profile, or a set with no known
 * pricing, is returned exactly as picker order presents it. Returns an empty
 * array when no vision profile exists.
 */
export function rankVisionProfiles(): string[] {
  const visionProfileKeys: string[] = [];
  for (const profile of getModelProfiles()) {
    if (profile.isDisabled) {
      continue;
    }
    if (doesSupportVision(profile)) {
      visionProfileKeys.push(profile.key);
    }
  }
  return rankByInputPrice(visionProfileKeys);
}

/**
 * Order profile keys by resolved input-token price ascending. `profileKeys`
 * arrives in picker order; unknown-price profiles rank after every priced
 * profile and, along with equal-priced ones, keep that incoming order. A list
 * of zero or one key is returned without pricing any profile, so single-profile
 * selection stays identical to picker order.
 */
function rankByInputPrice(profileKeys: string[]): string[] {
  if (profileKeys.length <= 1) {
    return profileKeys;
  }
  return profileKeys
    .map((key, index) => ({
      key,
      index,
      // Unknown price sorts after every known price.
      price: getProfileInputTokenPrice(key) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) =>
      a.price !== b.price ? a.price - b.price : a.index - b.index,
    )
    .map((entry) => entry.key);
}

/**
 * Build a sweep-scoped {@link VisionProviderResolver} over the ranked vision
 * profiles. Construct one per hook invocation and thread it through the sweep;
 * its memoization keeps provider resolution to at most once per sweep, however
 * many images the sweep captions.
 */
export function createVisionProviderResolver(
  logger: PluginLogger,
): VisionProviderResolver {
  const rankedKeys = rankVisionProfiles();
  let pending: Promise<ResolvedVisionProvider | null> | undefined;

  const attempt = async (): Promise<ResolvedVisionProvider | null> => {
    for (const profileKey of rankedKeys) {
      try {
        const provider = await getConfiguredProvider("vision", {
          overrideProfile: profileKey,
          forceOverrideProfile: true,
        });
        if (provider) {
          return { profileKey, provider };
        }
      } catch (err) {
        // A hard config error (missing/mismatched `provider_connection`) throws
        // rather than resolving `null`. Treat it exactly like a `null`
        // resolution: log it and fall through to the next ranked candidate so
        // one broken profile can't sink captioning for the whole sweep. This
        // also keeps the memoized promise from caching a rejection.
        logger.warn(
          {
            plugin: "image-fallback",
            profileKey,
            err: err instanceof Error ? err.message : String(err),
          },
          "Vision provider candidate threw during resolution; trying next",
        );
      }
    }
    if (rankedKeys.length > 0) {
      logger.warn(
        { plugin: "image-fallback", candidates: rankedKeys.length },
        "No vision provider resolved for captioning across ranked profiles",
      );
    }
    return null;
  };

  return {
    hasCandidates: () => rankedKeys.length > 0,
    // Memoize the in-flight promise so the whole sweep shares one resolution.
    resolve: () => (pending ??= attempt()),
  };
}

/**
 * Caption a single image block via the sweep's resolved vision provider.
 *
 * @param image     The image content block to caption.
 * @param conversationId  Conversation the image belongs to, recorded on the
 *          cache row so `conversation-deleted` cleanup stays accurate.
 * @param resolver  Sweep-scoped resolver that supplies the first usable
 *          (cheapest-first) vision provider; resolution is deferred until an
 *          uncached image needs it and shared across the sweep.
 * @param logger    Turn-scoped logger for attribution.
 * @returns The caption text, or `null` when captioning failed (caller should
 *          use a fail-open placeholder).
 */
export async function captionImage(
  image: ImageContent,
  conversationId: string,
  resolver: VisionProviderResolver,
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

  // Resolve the provider only once the sweep hits an uncached image; the
  // resolver memoizes so a multi-image sweep resolves at most once.
  const visionProvider = await resolver.resolve();
  if (!visionProvider) {
    return null;
  }
  const { profileKey, provider } = visionProvider;

  try {
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
          conversationId,
          overrideProfile: profileKey,
          forceOverrideProfile: true,
          tool_choice: { type: "none" },
        },
        signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
      },
    );

    // Vision captioning returns text content; concatenate any text blocks
    // (effectively always one here, since tool use is disabled).
    const caption = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(" ")
      .trim();
    if (caption.length > 0) {
      setCachedCaption(hash, conversationId, caption);
      return caption;
    }

    logger.warn(
      { plugin: "image-fallback" },
      "Vision captioning returned empty text",
    );
    return null;
  } catch (err) {
    logger.warn(
      { plugin: "image-fallback", err },
      "Vision captioning call failed",
    );
    return null;
  }
}

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
  getModelInputTokenPrice,
  getModelProfiles,
  getProfileInputTokenPrice,
  type ImageContent,
  type PluginLogger,
  type Provider,
  resolveCallSiteModel,
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

/**
 * One caption target the resolver can attempt, carrying only what the caption
 * call needs. The `vision` call-site default and every enabled vision-capable
 * profile are candidates; {@link buildVisionCandidates} ranks them by price.
 */
export interface VisionCandidate {
  /**
   * Profile key to pin via `overrideProfile`, or `null` for the `vision`
   * call-site default (no profile pin — the resolver's own chain picks the
   * model). Threaded through to the caption call so it dispatches on the same
   * target it resolved.
   */
  overrideProfile: string | null;
  /** Identifier for logs: a profile key, or `call-site default (<model>)`. */
  label: string;
}

/** A caption candidate whose provider resolved and is ready to caption. */
export interface ResolvedVisionProvider {
  /** The candidate the provider was resolved for. */
  candidate: VisionCandidate;
  /** Provider handle bound to that candidate via the `vision` call site. */
  provider: Provider;
}

/**
 * Rank-then-try caption-target selection, scoped to a single sweep.
 *
 * {@link hasCandidates} answers the cheap, synchronous question "does any
 * caption target (the vision call-site default or an enabled vision-capable
 * profile) exist to attempt captioning?" so the caller can distinguish "no
 * vision model configured" from "captioning failed" without resolving a
 * provider. {@link resolve} walks the ranked candidates cheapest first and
 * returns the first one whose provider actually resolves — so a cheapest
 * candidate that resolves to `null` (dangling connection, unavailable
 * credential, a BYOK install missing the call-site default's provider) or that
 * *throws* a hard config error (missing/mismatched `provider_connection`) falls
 * through to the next usable one rather than silently breaking captioning.
 * Resolution is lazy (never runs for an all-cache-hit sweep) and memoized (one
 * resolution per sweep, reused across every image).
 */
export interface VisionProviderResolver {
  /** Whether any caption candidate exists to caption with. */
  hasCandidates(): boolean;
  /**
   * The first usable caption provider in cheapest-first order, or `null` when
   * no candidate resolves. A candidate that throws during resolution is treated
   * exactly like a `null` resolution — logged and skipped — so `resolve()`
   * never rejects; it settles to `null` only after every candidate is
   * exhausted. Resolves lazily on first call and memoizes the settled result
   * for the rest of the sweep.
   */
  resolve(): Promise<ResolvedVisionProvider | null>;
}

/**
 * Assemble the caption candidates for the workspace, cheapest first.
 *
 * Candidates are the `vision` call-site default (the shipped managed-install
 * captioner, resolved with no profile override) plus every enabled,
 * vision-capable workspace profile in `getModelProfiles()` order (the order the
 * `/model` picker shows them). The call-site default is included only when its
 * resolved model actually supports vision — a workspace `llm.callSites.vision`
 * override or a BYOK default provider could resolve it to a text-only model,
 * which must be excluded here rather than fail at caption time.
 *
 * All candidates are ranked by resolved input-token price ascending — any
 * vision model captions a 1-2 sentence description adequately, so cost is the
 * tiebreak. Candidates the catalog can't price rank after every priced one, and
 * equal prices keep assembly order: the call-site default leads the profiles,
 * and profiles keep picker order. Returns an empty array when nothing can
 * caption.
 */
export function buildVisionCandidates(): VisionCandidate[] {
  const priced: Array<{ candidate: VisionCandidate; price: number | null }> =
    [];

  const callSiteModel = resolveCallSiteModel("vision");
  if (callSiteModel != null && doesSupportVision(callSiteModel)) {
    priced.push({
      candidate: {
        overrideProfile: null,
        label: `call-site default (${callSiteModel})`,
      },
      price: getModelInputTokenPrice(callSiteModel),
    });
  }

  for (const profile of getModelProfiles()) {
    if (profile.isDisabled) {
      continue;
    }
    if (doesSupportVision(profile)) {
      priced.push({
        candidate: { overrideProfile: profile.key, label: profile.key },
        price: getProfileInputTokenPrice(profile.key),
      });
    }
  }

  return priced
    .map((entry, index) => ({
      candidate: entry.candidate,
      index,
      // Unknown price sorts after every known price.
      price: entry.price ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) =>
      a.price !== b.price ? a.price - b.price : a.index - b.index,
    )
    .map((entry) => entry.candidate);
}

/**
 * The `getConfiguredProvider` opts a candidate resolves with. A profile
 * candidate floats its pinned profile above the call-site layers; the call-site
 * default candidate passes no override so the resolver's own chain (the shipped
 * model pin, or a workspace/BYOK override) selects the model.
 */
function candidateProviderOpts(candidate: VisionCandidate) {
  return candidate.overrideProfile != null
    ? { overrideProfile: candidate.overrideProfile, forceOverrideProfile: true }
    : {};
}

/**
 * Build a sweep-scoped {@link VisionProviderResolver} over the ranked caption
 * candidates. Construct one per hook invocation and thread it through the
 * sweep; its memoization keeps provider resolution to at most once per sweep,
 * however many images the sweep captions.
 */
export function createVisionProviderResolver(
  logger: PluginLogger,
): VisionProviderResolver {
  const candidates = buildVisionCandidates();
  let pending: Promise<ResolvedVisionProvider | null> | undefined;

  const attempt = async (): Promise<ResolvedVisionProvider | null> => {
    for (const candidate of candidates) {
      try {
        const provider = await getConfiguredProvider(
          "vision",
          candidateProviderOpts(candidate),
        );
        if (provider) {
          return { candidate, provider };
        }
      } catch (err) {
        // A hard config error (missing/mismatched `provider_connection`) throws
        // rather than resolving `null`. Treat it exactly like a `null`
        // resolution: log it and fall through to the next ranked candidate so
        // one broken candidate can't sink captioning for the whole sweep. This
        // also keeps the memoized promise from caching a rejection.
        logger.warn(
          {
            plugin: "image-fallback",
            candidate: candidate.label,
            err: err instanceof Error ? err.message : String(err),
          },
          "Vision provider candidate threw during resolution; trying next",
        );
      }
    }
    if (candidates.length > 0) {
      logger.warn(
        { plugin: "image-fallback", candidates: candidates.length },
        "No vision provider resolved for captioning across ranked candidates",
      );
    }
    return null;
  };

  return {
    hasCandidates: () => candidates.length > 0,
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
  const { candidate, provider } = visionProvider;

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
          // Dispatch on the same target the candidate resolved: a profile
          // candidate re-pins its profile; the call-site default passes no
          // override so the resolver's chain selects the model.
          ...candidateProviderOpts(candidate),
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

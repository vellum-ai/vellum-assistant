import type { ContentBlock } from "../../providers/types.js";

/**
 * Text content block carrying a `cache_control` breakpoint with a 1-hour TTL.
 * Shared by the v3 router (the static leaf-tree block) and selector (each
 * leaf's static `<pages>` block): these prefixes are stable across turns — the
 * leaf tree is byte-identical every turn, and a leaf's pages block changes only
 * when its pages/summaries do — while v3 turns are frequently more than the
 * default 5-minute cache window apart. A 1h TTL keeps the prefix warm across
 * those gaps so it is read from cache rather than re-created every turn; the
 * volatile current-message block is rendered after this one and left un-cached.
 * Haiku does not support the extended-cache-ttl beta, so the Anthropic provider
 * strips this `ttl` for Haiku models.
 *
 * Our internal `TextContent` type omits `cache_control` (only the Anthropic
 * provider transforms it onto the wire), so we reach through a `Record` cast to
 * keep the core types provider-agnostic.
 */
export function cachedTextBlock(text: string): ContentBlock {
  const block: ContentBlock = { type: "text", text };
  (block as unknown as Record<string, unknown>).cache_control = {
    type: "ephemeral",
    ttl: "1h",
  };
  return block;
}

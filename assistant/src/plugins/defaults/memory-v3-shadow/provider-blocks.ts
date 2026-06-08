import type { ContentBlock } from "../../../providers/types.js";

/**
 * Text content block carrying a `cache_control` breakpoint with a 1-hour TTL.
 * For a v3 prefix that is stable across turns (e.g. a static index block whose
 * bytes change only when the underlying pages/summaries do) while v3 turns are
 * frequently more than the default 5-minute cache window apart, a 1h TTL keeps
 * the prefix warm across those gaps so it is read from cache rather than
 * re-created every turn; a volatile current-message block is rendered after the
 * cached prefix and left un-cached. Haiku does not support the
 * extended-cache-ttl beta, so the Anthropic provider strips this `ttl` for
 * Haiku models.
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

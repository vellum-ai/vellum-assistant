import type { ContentBlock } from "../../providers/types.js";

/**
 * Text content block carrying an ephemeral `cache_control` breakpoint. Our
 * internal `TextContent` type omits the field (only the Anthropic provider
 * transforms it onto the wire), so we reach through a `Record` cast — this
 * keeps the core types provider-agnostic. Shared by the v3 router and selector,
 * whose STATIC numbered blocks are stable across turns and so cache well.
 */
export function cachedTextBlock(text: string): ContentBlock {
  const block: ContentBlock = { type: "text", text };
  (block as unknown as Record<string, unknown>).cache_control = {
    type: "ephemeral",
  };
  return block;
}

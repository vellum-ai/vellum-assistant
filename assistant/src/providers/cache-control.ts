import type { ContentBlock } from "./types.js";

/**
 * Build a text content block carrying an ephemeral `cache_control` breakpoint
 * with a 1h TTL, marking a byte-stable prefix the provider KV cache should
 * persist across calls.
 *
 * The Anthropic SDK accepts the field as an extra property on text blocks, but
 * the internal `TextContent` type intentionally omits it (only the Anthropic
 * provider transforms it onto the wire — block-level `cache_control` is
 * preserved through `toAnthropicBlockSafe`), so we reach through a `Record`
 * cast for the same reason `anthropic/client.ts` does — it keeps the core
 * types provider-agnostic. The 1h TTL matches the provider's auto-applied
 * breakpoints (see `cacheTtl` in `providers/anthropic/client.ts`); the
 * `extended-cache-ttl-2025-04-11` beta header is added unconditionally for
 * non-Haiku models in `client.ts` (Haiku models have the `ttl` stripped
 * provider-side), so this works without any call-site config.
 */
export function cachedTextBlock(text: string): ContentBlock {
  const block: ContentBlock = { type: "text", text };
  (block as unknown as Record<string, unknown>).cache_control = {
    type: "ephemeral",
    ttl: "1h",
  };
  return block;
}

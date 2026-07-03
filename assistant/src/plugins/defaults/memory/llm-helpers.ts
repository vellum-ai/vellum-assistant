import type {
  ContentBlock,
  Message,
  ProviderResponse,
  ToolUseContent,
} from "@vellumai/plugin-api";

/**
 * Small pure helpers over the LLM request/response types the memory plugin
 * runs its own inference with (via `getConfiguredProvider`). They live inside
 * the plugin — rather than importing the host's `providers/*` — so memory
 * depends only on its own files plus `@vellumai/plugin-api`, the boundary the
 * plugin model enforces. Every type they touch is exported from the contract.
 */

/**
 * Extract the first text block's text from a ProviderResponse.
 * Returns empty string if no text block is found.
 */
export function extractText(response: ProviderResponse): string {
  const block = response.content.find(
    (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
  );
  return block?.text?.trim() ?? "";
}

/**
 * Find the first tool_use block in a ProviderResponse.
 */
export function extractToolUse(
  response: ProviderResponse,
): ToolUseContent | undefined {
  return response.content.find(
    (b): b is ToolUseContent => b.type === "tool_use",
  );
}

/**
 * Build a single user message in the provider Message format.
 */
export function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

/**
 * Build a text content block carrying an ephemeral `cache_control` breakpoint
 * with a 1h TTL, marking a byte-stable prefix the provider KV cache should
 * persist across calls. The internal `TextContent` type omits the field (only
 * the Anthropic provider transforms it onto the wire, preserved through
 * `toAnthropicBlockSafe`), so we reach through a `Record` cast to keep the core
 * types provider-agnostic. The 1h TTL matches the provider's auto-applied
 * breakpoints; Haiku models have the `ttl` stripped provider-side.
 */
export function cachedTextBlock(text: string): ContentBlock {
  const block: ContentBlock = { type: "text", text };
  (block as unknown as Record<string, unknown>).cache_control = {
    type: "ephemeral",
    ttl: "1h",
  };
  return block;
}

/**
 * Function-calling schema handed to the provider as an LLM tool (the shape the
 * model sees: name, description, input JSON schema). Structurally matches the
 * host provider wire-spec (`providers/types` → `tools/tool-types` `ToolDefinition`)
 * so instances stay assignable to `Provider.sendMessage({ tools })`. Kept local
 * rather than imported from `@vellumai/plugin-api`: the contract's same-named
 * `ToolDefinition` is the richer, all-optional author-facing tool type, which
 * doesn't match the all-required wire-spec at the `: ToolDefinition` sites here.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: object;
}

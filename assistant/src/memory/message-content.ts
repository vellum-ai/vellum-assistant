import type { ContentBlock } from "../providers/types.js";
import { escapeXmlAttr } from "../util/xml.js";

export function extractTextFromStoredMessageContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") return parsed;
    if (!Array.isArray(parsed)) return raw;
    const blocks = parsed as ContentBlock[];
    const lines: string[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          lines.push(block.text);
          break;
        case "tool_use":
          lines.push(`Tool use (${block.name}): ${stableJson(block.input)}`);
          break;
        case "tool_result":
          lines.push(
            `Tool result${block.is_error ? " <error />" : ""}: ${block.content}`,
          );
          break;
        case "thinking":
          lines.push(block.thinking);
          break;
        case "redacted_thinking":
          lines.push("<redacted_thinking />");
          break;
        case "image":
          lines.push(
            `<image type="${escapeXmlAttr(block.source.media_type)}" />`,
          );
          break;
        case "file":
          if (block.extracted_text) {
            lines.push(
              `File (${block.source.filename}): ${block.extracted_text}`,
            );
          } else {
            lines.push(
              `<file name="${escapeXmlAttr(
                block.source.filename,
              )}" type="${escapeXmlAttr(block.source.media_type)}" />`,
            );
          }
          break;
        case "server_tool_use": {
          const query =
            typeof block.input?.query === "string"
              ? block.input.query
              : block.name;
          lines.push(`[web search: ${query}]`);
          break;
        }
        case "web_search_tool_result":
          lines.push("[web search results]");
          break;
        default:
          lines.push("<unknown_content_block />");
      }
    }
    return lines.join("\n").trim();
  } catch {
    return raw;
  }
}

export function extractMediaBlocks(raw: string): Array<{
  type: "image";
  data: Buffer;
  mimeType: string;
  index: number;
}> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const results: Array<{
      type: "image";
      data: Buffer;
      mimeType: string;
      index: number;
    }> = [];
    for (let i = 0; i < parsed.length; i++) {
      const block = parsed[i] as ContentBlock;
      if (block.type === "image") {
        results.push({
          type: "image" as const,
          data: Buffer.from(block.source.data, "base64"),
          mimeType: block.source.media_type,
          index: i,
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Lightweight variant of extractMediaBlocks that returns only type and index
 * metadata without decoding base64 image data into Buffers.
 */
export function extractMediaBlockMeta(
  raw: string,
): Array<{ type: "image"; index: number }> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const results: Array<{ type: "image"; index: number }> = [];
    for (let i = 0; i < parsed.length; i++) {
      const block = parsed[i] as { type?: string };
      if (block.type === "image") {
        results.push({ type: "image" as const, index: i });
      }
    }
    return results;
  } catch {
    return [];
  }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable />";
  }
}

/**
 * Coerce stored message content into a single human-readable text string,
 * dropping non-text blocks (images, tool calls, tool results, thinking,
 * …). Used by call sites that want only the spoken text — sweep-model
 * context, RAG backfill, bookmark previews. For richer renderings that
 * include tool metadata, use {@link extractTextFromStoredMessageContent}
 * instead.
 *
 * Handles the two on-disk shapes:
 *   - Modern rows: JSON-serialized `ContentBlock[]`
 *   - Legacy rows: plain string
 *
 * Parse failures fall back to returning the raw input trimmed (the
 * legacy-string path).
 */
export function stringifyMessageContent(stored: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return stored.trim();
  }
  if (typeof parsed === "string") return parsed.trim();
  if (!Array.isArray(parsed)) return "";
  const parts: string[] = [];
  for (const block of parsed) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n").trim();
}

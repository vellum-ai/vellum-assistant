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

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable />";
  }
}

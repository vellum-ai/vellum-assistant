import type { ContentBlock } from '../providers/types.js';

export function extractTextFromStoredMessageContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (!Array.isArray(parsed)) return raw;
    const blocks = parsed as ContentBlock[];
    const lines: string[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          lines.push(block.text);
          break;
        case 'tool_use':
          lines.push(`Tool use (${block.name}): ${stableJson(block.input)}`);
          break;
        case 'tool_result':
          lines.push(`Tool result${block.is_error ? ' [error]' : ''}: ${block.content}`);
          break;
        case 'thinking':
          lines.push(block.thinking);
          break;
        case 'redacted_thinking':
          lines.push('[redacted_thinking]');
          break;
        case 'image':
          lines.push(`[image ${block.source.media_type}]`);
          break;
        default:
          lines.push('[unknown content block]');
      }
    }
    return lines.join('\n').trim();
  } catch {
    return raw;
  }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

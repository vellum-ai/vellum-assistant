import type { ContentBlock, Message } from '../providers/types.js';

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;
const TEXT_BLOCK_OVERHEAD_TOKENS = 2;
const TOOL_BLOCK_OVERHEAD_TOKENS = 16;
const IMAGE_BLOCK_TOKENS = 1024;
const FILE_BLOCK_OVERHEAD_TOKENS = 48;
const OTHER_BLOCK_TOKENS = 16;
const SYSTEM_PROMPT_OVERHEAD_TOKENS = 8;

export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateContentBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return TEXT_BLOCK_OVERHEAD_TOKENS + estimateTextTokens(block.text);
    case 'tool_use':
      return TOOL_BLOCK_OVERHEAD_TOKENS
        + estimateTextTokens(block.name)
        + estimateTextTokens(stableJson(block.input));
    case 'tool_result':
      return TOOL_BLOCK_OVERHEAD_TOKENS
        + estimateTextTokens(block.tool_use_id)
        + estimateTextTokens(block.content);
    case 'image':
      return IMAGE_BLOCK_TOKENS;
    case 'file':
      return FILE_BLOCK_OVERHEAD_TOKENS
        + estimateTextTokens(block.source.filename)
        + estimateTextTokens(block.source.media_type)
        + estimateTextTokens(block.source.data)
        + estimateTextTokens(block.extracted_text ?? '');
    case 'thinking':
      return TEXT_BLOCK_OVERHEAD_TOKENS + estimateTextTokens(block.thinking);
    case 'redacted_thinking':
      return TEXT_BLOCK_OVERHEAD_TOKENS + estimateTextTokens(block.data);
    default:
      return OTHER_BLOCK_TOKENS;
  }
}

export function estimateMessageTokens(message: Message): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  for (const block of message.content) {
    total += estimateContentBlockTokens(block);
  }
  return total;
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

export function estimatePromptTokens(messages: Message[], systemPrompt?: string): number {
  const systemTokens = systemPrompt
    ? SYSTEM_PROMPT_OVERHEAD_TOKENS + estimateTextTokens(systemPrompt)
    : 0;
  return systemTokens + estimateMessagesTokens(messages);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

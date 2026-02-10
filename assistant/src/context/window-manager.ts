import { createUserMessage } from '../agent/message-types.js';
import type { ContextWindowConfig } from '../config/types.js';
import type { ContentBlock, Message, Provider } from '../providers/types.js';
import { getLogger } from '../util/logger.js';
import { estimatePromptTokens, estimateTextTokens } from './token-estimator.js';

const log = getLogger('context-window');

export const CONTEXT_SUMMARY_MARKER = '[Context Summary v1]';
const CHUNK_MIN_TOKENS = 1000;
const MAX_BLOCK_PREVIEW_CHARS = 3000;
const MAX_FALLBACK_SUMMARY_CHARS = 12000;
const MAX_CONTEXT_SUMMARY_CHARS = 16000;

const SUMMARY_SYSTEM_PROMPT = [
  'You compress long assistant conversations into durable working memory.',
  'Focus on actionable state, not prose.',
  'Preserve concrete facts: goals, constraints, decisions, pending questions, file paths, commands, errors, and TODOs.',
  'Remove repetition and stale details that were superseded.',
  'Return concise markdown using these section headers exactly:',
  '## Goals',
  '## Constraints',
  '## Decisions',
  '## Open Threads',
  '## Key Artifacts',
  '## Recent Progress',
].join('\n');

export interface ContextWindowResult {
  messages: Message[];
  compacted: boolean;
  previousEstimatedInputTokens: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  compactedMessages: number;
  compactedPersistedMessages: number;
  summaryCalls: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryModel: string;
  summaryText: string;
  reason?: string;
}

export class ContextWindowManager {
  constructor(
    private readonly provider: Provider,
    private readonly systemPrompt: string,
    private readonly config: ContextWindowConfig,
  ) {}

  async maybeCompact(messages: Message[], signal?: AbortSignal): Promise<ContextWindowResult> {
    const previousEstimatedInputTokens = estimatePromptTokens(messages, this.systemPrompt);
    const thresholdTokens = Math.floor(this.config.maxInputTokens * this.config.compactThreshold);
    const existingSummary = getSummaryFromContextMessage(messages[0]);

    if (!this.config.enabled) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: '',
        summaryText: existingSummary ?? '',
        reason: 'context window compaction disabled',
      };
    }

    if (previousEstimatedInputTokens < thresholdTokens) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: '',
        summaryText: existingSummary ?? '',
        reason: 'below compaction threshold',
      };
    }

    const summaryOffset = existingSummary !== null ? 1 : 0;
    const userTurnStarts = collectUserTurnStartIndexes(messages);
    if (userTurnStarts.length === 0) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: '',
        summaryText: existingSummary ?? '',
        reason: 'no user turns available for compaction',
      };
    }

    const keepPlan = this.pickKeepBoundary(messages, userTurnStarts);
    if (keepPlan.keepFromIndex <= summaryOffset) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: '',
        summaryText: existingSummary ?? '',
        reason: 'unable to compact while keeping recent turns',
      };
    }

    const compactableMessages = messages.slice(summaryOffset, keepPlan.keepFromIndex);
    if (compactableMessages.length === 0) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: '',
        summaryText: existingSummary ?? '',
        reason: 'no eligible messages to compact',
      };
    }

    const compactedPersistedMessages = countPersistedMessages(compactableMessages);
    const chunks = chunkMessages(compactableMessages, Math.max(this.config.chunkTokens, CHUNK_MIN_TOKENS));
    let summary = existingSummary ?? 'No previous summary.';
    let summaryInputTokens = 0;
    let summaryOutputTokens = 0;
    let summaryModel = '';
    let summaryCalls = 0;

    for (const chunk of chunks) {
      const summaryUpdate = await this.updateSummary(summary, chunk, signal);
      summary = summaryUpdate.summary;
      summaryInputTokens += summaryUpdate.inputTokens;
      summaryOutputTokens += summaryUpdate.outputTokens;
      summaryModel = summaryUpdate.model || summaryModel;
      summaryCalls += 1;
    }

    const compactedMessages = [
      createContextSummaryMessage(summary),
      ...messages.slice(keepPlan.keepFromIndex),
    ];
    const estimatedInputTokens = estimatePromptTokens(compactedMessages, this.systemPrompt);
    log.info(
      {
        previousEstimatedInputTokens,
        estimatedInputTokens,
        compactedMessages: compactableMessages.length,
        compactedPersistedMessages,
        keepTurns: keepPlan.keepTurns,
        summaryCalls,
      },
      'Compacted conversation context window',
    );

    return {
      messages: compactedMessages,
      compacted: true,
      previousEstimatedInputTokens,
      estimatedInputTokens,
      maxInputTokens: this.config.maxInputTokens,
      thresholdTokens,
      compactedMessages: compactableMessages.length,
      compactedPersistedMessages,
      summaryCalls,
      summaryInputTokens,
      summaryOutputTokens,
      summaryModel,
      summaryText: summary,
    };
  }

  private pickKeepBoundary(
    messages: Message[],
    userTurnStarts: number[],
  ): { keepFromIndex: number; keepTurns: number } {
    let keepTurns = Math.min(this.config.preserveRecentUserTurns, userTurnStarts.length);
    keepTurns = Math.max(1, keepTurns);
    let keepFromIndex = userTurnStarts[userTurnStarts.length - keepTurns] ?? messages.length;

    while (keepTurns > 1) {
      const projectedMessages = [
        createContextSummaryMessage('Projected summary'),
        ...messages.slice(keepFromIndex),
      ];
      const projectedTokens = estimatePromptTokens(projectedMessages, this.systemPrompt);
      if (projectedTokens <= this.config.targetInputTokens) break;
      keepTurns -= 1;
      keepFromIndex = userTurnStarts[userTurnStarts.length - keepTurns] ?? keepFromIndex;
    }

    return { keepFromIndex, keepTurns };
  }

  private async updateSummary(
    currentSummary: string,
    chunk: string,
    signal?: AbortSignal,
  ): Promise<{ summary: string; inputTokens: number; outputTokens: number; model: string }> {
    const prompt = buildSummaryPrompt(currentSummary, chunk);
    try {
      const response = await this.provider.sendMessage(
        [createUserMessage(prompt)],
        undefined,
        SUMMARY_SYSTEM_PROMPT,
        {
          config: { max_tokens: this.config.summaryMaxTokens },
          signal,
        },
      );

      const nextSummary = extractText(response.content).trim();
      if (nextSummary.length > 0) {
        return {
          summary: clampSummary(nextSummary),
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          model: response.model,
        };
      }
    } catch (err) {
      log.warn({ err }, 'Summary generation failed, using local fallback');
    }

    return {
      summary: fallbackSummary(currentSummary, chunk),
      inputTokens: 0,
      outputTokens: 0,
      model: '',
    };
  }
}

function collectUserTurnStartIndexes(messages: Message[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    if (getSummaryFromContextMessage(message) !== null) continue;
    if (message.content.some((block) => block.type === 'tool_result')) continue;
    starts.push(i);
  }
  return starts;
}

function countPersistedMessages(messages: Message[]): number {
  return messages.filter((message) => {
    if (message.role === 'assistant') return true;
    if (getSummaryFromContextMessage(message) !== null) return false;
    return !message.content.some((block) => block.type === 'tool_result');
  }).length;
}

export function getSummaryFromContextMessage(message: Message | undefined): string | null {
  if (!message) return null;
  const text = extractText(message.content).trim();
  if (!text.startsWith(CONTEXT_SUMMARY_MARKER)) return null;
  return text.slice(CONTEXT_SUMMARY_MARKER.length).trim();
}

export function createContextSummaryMessage(summary: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: `${CONTEXT_SUMMARY_MARKER}\n${clampSummary(summary)}` }],
  };
}

function buildSummaryPrompt(currentSummary: string, chunk: string): string {
  return [
    'Update the summary with new transcript data.',
    'If new information conflicts with older notes, keep the most recent and explicit detail.',
    'Keep all unresolved asks and next steps.',
    '',
    '### Existing Summary',
    currentSummary.trim().length > 0 ? currentSummary.trim() : 'None.',
    '',
    '### New Transcript Chunk',
    chunk,
  ].join('\n');
}

function chunkMessages(messages: Message[], maxTokensPerChunk: number): string[] {
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    const line = serializeForSummary(messages[i], i);
    const lineTokens = estimateTextTokens(line) + 1;
    if (currentChunk.length > 0 && currentTokens + lineTokens > maxTokensPerChunk) {
      chunks.push(currentChunk.join('\n\n'));
      currentChunk = [];
      currentTokens = 0;
    }
    currentChunk.push(line);
    currentTokens += lineTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n\n'));
  }

  return chunks;
}

function serializeForSummary(message: Message, index: number): string {
  const lines = [`Message #${index + 1} (${message.role})`];

  for (const block of message.content) {
    lines.push(serializeBlock(block));
  }

  return lines.join('\n');
}

function serializeBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return `text: ${clampText(block.text)}`;
    case 'tool_use':
      return `tool_use ${block.name}: ${clampText(stableJson(block.input))}`;
    case 'tool_result':
      return `tool_result ${block.tool_use_id}${block.is_error ? ' (error)' : ''}: ${clampText(block.content)}`;
    case 'image':
      return `image: ${block.source.media_type}, ${Math.ceil(block.source.data.length / 4) * 3} bytes(base64)`;
    case 'file': {
      const sizeBytes = Math.ceil(block.source.data.length / 4) * 3;
      const parts = [
        `file: ${block.source.filename}`,
        block.source.media_type,
        `${sizeBytes} bytes(base64)`,
      ];
      if (block.extracted_text) {
        parts.push(`text=${clampText(block.extracted_text)}`);
      }
      return parts.join(', ');
    }
    case 'thinking':
      return `thinking: ${clampText(block.thinking)}`;
    case 'redacted_thinking':
      return 'redacted_thinking';
    default:
      return 'unknown_block';
  }
}

function clampText(text: string): string {
  if (text.length <= MAX_BLOCK_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_BLOCK_PREVIEW_CHARS)}... [truncated ${text.length - MAX_BLOCK_PREVIEW_CHARS} chars]`;
}

function fallbackSummary(currentSummary: string, chunk: string): string {
  const lines = chunk
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const recentLines = lines.slice(-120).join('\n');
  const merged = [
    currentSummary.trim(),
    '## Recent Progress',
    recentLines.length > 0 ? recentLines : 'No new details.',
  ].filter((part) => part.length > 0).join('\n\n');
  if (merged.length <= MAX_FALLBACK_SUMMARY_CHARS) return merged;
  return merged.slice(merged.length - MAX_FALLBACK_SUMMARY_CHARS);
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function clampSummary(summary: string): string {
  if (summary.length <= MAX_CONTEXT_SUMMARY_CHARS) return summary;
  return `${summary.slice(0, MAX_CONTEXT_SUMMARY_CHARS)}...`;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

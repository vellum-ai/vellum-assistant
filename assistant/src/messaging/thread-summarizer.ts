import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import { truncate } from '../util/truncate.js';
import type { ThreadMessage, ThreadSummary } from './types.js';

const log = getLogger('thread-summarizer');

const SUMMARIZATION_MODEL = 'claude-haiku-4-5-20251001';
const SUMMARIZATION_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 4000;
const CHARS_PER_TOKEN = 4;

// Keep the first N and last N messages when truncating long threads
const KEEP_FIRST = 2;
const KEEP_LAST = 3;

const EMPTY_SUMMARY: ThreadSummary = {
  summary: '',
  participants: [],
  openQuestions: [],
  lastAction: '',
  sentiment: 'neutral',
  messageCount: 0,
};

const SYSTEM_PROMPT = `You are a thread summarization system. Given a conversation transcript, extract a structured summary.

Analyze the conversation and provide:
- summary: A concise overview of the conversation (2-4 sentences)
- participants: List of participants with optional roles (inferred from context)
- openQuestions: Unresolved questions or pending items raised in the thread
- lastAction: The most recent meaningful action or statement in the thread
- sentiment: Overall emotional tone of the conversation (positive, neutral, negative, or mixed)

You MUST respond using the \`store_thread_summary\` tool. Do not respond with text.`;

const STORE_SUMMARY_TOOL = {
  name: 'store_thread_summary',
  description: 'Store the extracted thread summary',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description: 'Concise overview of the conversation (2-4 sentences)',
      },
      participants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            role: { type: 'string', description: 'Optional role inferred from context' },
          },
          required: ['name'],
        },
        description: 'List of conversation participants',
      },
      openQuestions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Unresolved questions or pending items',
      },
      lastAction: {
        type: 'string',
        description: 'The most recent meaningful action or statement',
      },
      sentiment: {
        type: 'string',
        enum: ['positive', 'neutral', 'negative', 'mixed'],
        description: 'Overall emotional tone of the conversation',
      },
    },
    required: ['summary', 'participants', 'openQuestions', 'lastAction', 'sentiment'],
  },
};

// ── Formatting helpers ─────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function formatTranscript(messages: ThreadMessage[]): string {
  return messages
    .map((m) => `[${formatTimestamp(m.timestamp)}] ${m.sender} (${m.channel}):\n${m.body}`)
    .join('\n\n');
}

/**
 * Truncate a thread to fit within a token budget while preserving context.
 * Always keeps the first few and last few messages so the LLM sees
 * the opening context and the most recent state.
 */
function truncateMessages(
  messages: ThreadMessage[],
  maxTokens: number,
): ThreadMessage[] {
  const fullTranscript = formatTranscript(messages);
  const estimatedTokens = fullTranscript.length / CHARS_PER_TOKEN;

  if (estimatedTokens <= maxTokens) {
    return messages;
  }

  // Always keep first KEEP_FIRST and last KEEP_LAST messages
  const first = messages.slice(0, KEEP_FIRST);
  const last = messages.slice(-KEEP_LAST);

  // If the thread is short enough that first+last windows overlap, we can't
  // split into first/middle/last — but we still need to honor the token budget.
  // Progressively drop the oldest messages (from the front) to keep the
  // newest context, which is more valuable for summarization.
  if (KEEP_FIRST + KEEP_LAST >= messages.length) {
    const kept = [...messages];
    while (kept.length > 1) {
      const transcript = formatTranscript(kept);
      if (transcript.length / CHARS_PER_TOKEN <= maxTokens) {
        return kept;
      }
      // Drop the first (oldest) message to prioritize keeping latest context
      kept.shift();
    }
    return kept;
  }

  // Try adding middle messages until budget is exceeded
  const middle = messages.slice(KEEP_FIRST, -KEEP_LAST);
  const kept: ThreadMessage[] = [...first];
  const budgetChars = maxTokens * CHARS_PER_TOKEN;

  // Reserve space for the last messages
  const lastTranscript = formatTranscript(last);
  const separatorOverhead = 40; // "[... N messages truncated ...]\n\n"
  let usedChars = formatTranscript(first).length + lastTranscript.length + separatorOverhead;

  for (const msg of middle) {
    const msgText = formatTranscript([msg]);
    if (usedChars + msgText.length > budgetChars) break;
    kept.push(msg);
    usedChars += msgText.length;
  }

  const truncatedCount = messages.length - kept.length - last.length;
  if (truncatedCount > 0) {
    // Insert a placeholder message to indicate truncation
    kept.push({
      id: '__truncated__',
      sender: 'system',
      body: `[... ${truncatedCount} message(s) omitted for brevity ...]`,
      timestamp: kept[kept.length - 1].timestamp + 1,
      channel: 'system',
    });
  }

  kept.push(...last);
  return kept;
}

function extractParticipants(messages: ThreadMessage[]): Array<{ name: string }> {
  const seen = new Set<string>();
  const participants: Array<{ name: string }> = [];
  for (const msg of messages) {
    if (!seen.has(msg.sender)) {
      seen.add(msg.sender);
      participants.push({ name: msg.sender });
    }
  }
  return participants;
}

// ── Single-message pass-through ────────────────────────────────────────

function summarizeSingleMessage(message: ThreadMessage): ThreadSummary {
  return {
    summary: truncate(message.body, 200),
    participants: [{ name: message.sender }],
    openQuestions: [],
    lastAction: truncate(message.body, 200),
    sentiment: 'neutral',
    messageCount: 1,
  };
}

// ── LLM-powered summarization ──────────────────────────────────────────

async function summarizeWithLLM(
  messages: ThreadMessage[],
  maxTokens: number,
): Promise<ThreadSummary> {
  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.warn('No Anthropic API key available for thread summarization, returning basic summary');
    return buildFallbackSummary(messages);
  }

  const truncated = truncateMessages(messages, maxTokens);
  const transcript = formatTranscript(truncated);

  try {
    const client = new Anthropic({ apiKey });
    const abortController = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const apiCall = client.messages.create({
      model: SUMMARIZATION_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [STORE_SUMMARY_TOOL],
      tool_choice: { type: 'tool' as const, name: 'store_thread_summary' },
      messages: [{
        role: 'user' as const,
        content: `Summarize this conversation thread (${messages.length} messages):\n\n${transcript}`,
      }],
    }, { signal: abortController.signal });

    // Swallow the abort rejection that fires when the timeout wins the race
    apiCall.catch(() => {});
    const response = await Promise.race([
      apiCall.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abortController.abort();
          reject(new Error('Thread summarization LLM timeout'));
        }, SUMMARIZATION_TIMEOUT_MS);
      }),
    ]);

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      log.warn('No tool_use block in summarization response, returning fallback');
      return buildFallbackSummary(messages);
    }

    const input = toolBlock.input as {
      summary?: string;
      participants?: Array<{ name: string; role?: string }>;
      openQuestions?: string[];
      lastAction?: string;
      sentiment?: string;
    };

    const validSentiments = new Set(['positive', 'neutral', 'negative', 'mixed']);
    const sentiment = validSentiments.has(input.sentiment ?? '')
      ? (input.sentiment as ThreadSummary['sentiment'])
      : 'neutral';

    return {
      summary: truncate(String(input.summary ?? ''), 2000, ''),
      participants: Array.isArray(input.participants)
        ? input.participants.map((p) => ({
            name: String(p.name),
            ...(p.role ? { role: String(p.role) } : {}),
          }))
        : extractParticipants(messages),
      openQuestions: Array.isArray(input.openQuestions)
        ? input.openQuestions.map((q) => String(q))
        : [],
      lastAction: truncate(String(input.lastAction ?? ''), 500, ''),
      sentiment,
      messageCount: messages.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'Thread summarization LLM call failed, returning fallback');
    return buildFallbackSummary(messages);
  }
}

// ── Fallback summary (no LLM) ─────────────────────────────────────────

function buildFallbackSummary(messages: ThreadMessage[]): ThreadSummary {
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const lastMsg = sorted[sorted.length - 1];

  return {
    summary: `Thread with ${messages.length} message(s) from ${extractParticipants(messages).map((p) => p.name).join(', ')}.`,
    participants: extractParticipants(messages),
    openQuestions: [],
    lastAction: truncate(lastMsg.body, 200),
    sentiment: 'neutral',
    messageCount: messages.length,
  };
}

// ── Public API ─────────────────────────────────────────────────────────

export async function summarizeThread(
  messages: ThreadMessage[],
  options?: { maxTokens?: number },
): Promise<ThreadSummary> {
  if (messages.length === 0) {
    return { ...EMPTY_SUMMARY, participants: [], openQuestions: [] };
  }

  // Sort chronologically
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);

  if (sorted.length === 1) {
    return summarizeSingleMessage(sorted[0]);
  }

  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  return summarizeWithLLM(sorted, maxTokens);
}

/**
 * LLM-powered classifier for cold outreach emails (sales, recruiting, marketing).
 * Works with metadata only (from, subject) to keep token usage low.
 */

import { createTimeout, extractToolUse, getConfiguredProvider, userMessage } from '../providers/provider-send-message.js';
import { getLogger } from '../util/logger.js';
import type { EmailMetadata } from './email-classifier.js';

const log = getLogger('outreach-classifier');

const MODEL_INTENT = 'latency-optimized' as const;
const TIMEOUT_MS = 30_000;
const BATCH_SIZE = 100;

export type OutreachType = 'sales' | 'recruiting' | 'marketing' | 'other';

export interface OutreachClassification {
  id: string;
  isOutreach: boolean;
  outreachType: OutreachType;
  confidence: number; // 0-1
  reasoning: string;
}

const VALID_OUTREACH_TYPES = new Set<OutreachType>(['sales', 'recruiting', 'marketing', 'other']);

const SYSTEM_PROMPT = 'You are a cold outreach detection system. Given email metadata (sender, subject), classify each email as outreach or not.\n\nOutreach signals to look for:\n- Generic greetings (\"Hi there\", \"Hope this finds you well\")\n- Scheduling links (Calendly, Chili Piper, cal.com)\n- Pitch language (\"quick chat\", \"15 minutes\", \"love to connect\", \"touching base\")\n- Recruiting templates (\"exciting opportunity\", \"your background\", \"perfect fit\")\n- Product/service promotion from unknown senders\n- Cold intro patterns (\"I came across your profile\", \"saw your company\")\n\nExplicitly NOT outreach (classify as other with isOutreach=false):\n- Personal emails from known contacts\n- Transactional emails (receipts, shipping, password resets)\n- Newsletters (these are already filtered out by query)\n- Calendar invites and event notifications\n\nFor each email, provide:\n- isOutreach: true if this is cold outreach, false otherwise\n- outreachType: \"sales\" (product/service pitch), \"recruiting\" (job opportunity), \"marketing\" (promotional from unknown sender), or \"other\" (not outreach)\n- confidence: 0.0 (uncertain) to 1.0 (certain)\n- reasoning: Brief explanation (1 sentence)\n\nYou MUST respond using the `store_outreach_classifications` tool. Do not respond with text.';

const STORE_OUTREACH_TOOL = {
  name: 'store_outreach_classifications',
  description: 'Store outreach classification results',
  input_schema: {
    type: 'object' as const,
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Email ID' },
            is_outreach: { type: 'boolean', description: 'Whether this is cold outreach' },
            outreach_type: {
              type: 'string',
              enum: ['sales', 'recruiting', 'marketing', 'other'],
            },
            confidence: { type: 'number', description: 'Confidence score 0-1' },
            reasoning: { type: 'string', description: 'Brief classification reasoning' },
          },
          required: ['id', 'is_outreach', 'outreach_type', 'confidence', 'reasoning'],
        },
      },
    },
    required: ['classifications'],
  },
};

function formatEmailsForPrompt(emails: EmailMetadata[]): string {
  return emails
    .map((e, i) => [
      '--- Email ' + (i + 1) + ' (ID: ' + e.id + ') ---',
      'From: ' + e.from,
      'Subject: ' + e.subject,
    ].join('\n'))
    .join('\n\n');
}

async function classifyBatch(emails: EmailMetadata[]): Promise<OutreachClassification[]> {
  const provider = getConfiguredProvider();
  if (!provider) {
    log.warn('Configured provider unavailable for outreach classification');
    return [];
  }

  const prompt = 'Classify these ' + emails.length + ' emails as outreach or not:\n\n' + formatEmailsForPrompt(emails);
  const { signal, cleanup } = createTimeout(TIMEOUT_MS);

  try {
    const response = await provider.sendMessage(
      [userMessage(prompt)],
      [STORE_OUTREACH_TOOL],
      SYSTEM_PROMPT,
      {
        config: {
          modelIntent: MODEL_INTENT,
          max_tokens: 4096,
          tool_choice: { type: 'tool' as const, name: 'store_outreach_classifications' },
        },
        signal,
      },
    );
    cleanup();

    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      log.warn('No tool_use block in outreach classification response');
      return [];
    }

    const input = toolBlock.input as {
      classifications?: Array<{
        id: string;
        is_outreach: boolean;
        outreach_type: string;
        confidence: number;
        reasoning: string;
      }>;
    };

    return (input.classifications ?? []).map((c) => ({
      id: c.id,
      isOutreach: Boolean(c.is_outreach),
      outreachType: VALID_OUTREACH_TYPES.has(c.outreach_type as OutreachType)
        ? (c.outreach_type as OutreachType)
        : 'other',
      confidence: Math.max(0, Math.min(1, c.confidence)),
      reasoning: c.reasoning,
    }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn({ err: message }, 'Outreach classification LLM call failed');
    return [];
  } finally {
    cleanup();
  }
}

export async function classifyOutreach(emails: EmailMetadata[]): Promise<OutreachClassification[]> {
  if (emails.length === 0) return [];

  const results: OutreachClassification[] = [];

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    const batchResults = await classifyBatch(batch);
    results.push(...batchResults);
  }

  return results;
}

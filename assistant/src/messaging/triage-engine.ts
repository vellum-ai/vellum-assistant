/**
 * Channel-agnostic message triage engine.
 *
 * Classifies an inbound message by combining sender context from the
 * contact graph, matching action playbooks, and an LLM call (Haiku)
 * for final classification. Results are persisted to the triageResults
 * table for accuracy review.
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuid } from 'uuid';
import { and, eq, isNull, desc } from 'drizzle-orm';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import { getDb } from '../memory/db.js';
import { memoryItems, triageResults } from '../memory/schema.js';
import { findContactByAddress } from '../contacts/contact-store.js';
import { parsePlaybookStatement } from '../playbooks/types.js';
import type { Playbook } from '../playbooks/types.js';
import type { ContactWithChannels } from '../contacts/types.js';
import type { InboundMessage, TriageResult } from './types.js';
import { DEFAULT_TRIAGE_CATEGORIES } from './types.js';

const log = getLogger('triage-engine');

const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';
const TRIAGE_CLASSIFICATION_TIMEOUT_MS = 15_000;

// ── Playbook fetching ────────────────────────────────────────────────

interface PlaybookMatch {
  id: string;
  playbook: Playbook;
}

/**
 * Fetch all active playbooks that could apply to this message's channel,
 * returning both the parsed Playbook and the memory item ID.
 */
function fetchMatchingPlaybooks(channel: string, scopeId = 'default'): PlaybookMatch[] {
  const db = getDb();

  const rows = db
    .select({
      id: memoryItems.id,
      statement: memoryItems.statement,
    })
    .from(memoryItems)
    .where(and(
      eq(memoryItems.kind, 'playbook'),
      eq(memoryItems.status, 'active'),
      eq(memoryItems.scopeId, scopeId),
      isNull(memoryItems.invalidAt),
    ))
    .orderBy(desc(memoryItems.importance))
    .all();

  const matches: PlaybookMatch[] = [];
  for (const row of rows) {
    const playbook = parsePlaybookStatement(row.statement);
    if (!playbook) continue;

    // Include if the playbook applies to all channels or matches this channel
    if (playbook.channel === '*' || playbook.channel === channel) {
      matches.push({ id: row.id, playbook });
    }
  }

  return matches;
}

// ── LLM classification ──────────────────────────────────────────────

function buildSystemPrompt(
  contact: ContactWithChannels | null,
  playbookMatches: PlaybookMatch[],
): string {
  const sections: string[] = [
    `You are a message triage system. Classify the incoming message into a category and suggest an action.`,
    ``,
    `Available categories (you may also use a custom category if none fit):`,
    ...DEFAULT_TRIAGE_CATEGORIES.map((c) => `- ${c}`),
  ];

  if (contact) {
    sections.push(
      ``,
      `<sender-context>`,
      `Name: ${contact.displayName}`,
    );
    if (contact.relationship) sections.push(`Relationship: ${contact.relationship}`);
    if (contact.importance !== 0.5) sections.push(`Importance: ${contact.importance}`);
    if (contact.responseExpectation) sections.push(`Response expectation: ${contact.responseExpectation}`);
    if (contact.preferredTone) sections.push(`Preferred tone: ${contact.preferredTone}`);
    sections.push(
      `Interaction count: ${contact.interactionCount}`,
      `</sender-context>`,
    );
  } else {
    sections.push(``, `Sender is not in the contact graph (unknown sender).`);
  }

  if (playbookMatches.length > 0) {
    sections.push(``, `<action-playbooks>`);
    for (const { playbook } of playbookMatches) {
      const channelLabel = playbook.channel === '*' ? 'all channels' : playbook.channel;
      const autonomyLabel = playbook.autonomyLevel === 'auto'
        ? 'execute automatically'
        : playbook.autonomyLevel === 'draft'
          ? 'draft for review'
          : 'notify only';
      sections.push(
        `- WHEN "${playbook.trigger}" on ${channelLabel} → ${playbook.action} [${autonomyLabel}, priority=${playbook.priority}]`,
      );
    }
    sections.push(`</action-playbooks>`);
  }

  sections.push(
    ``,
    `You MUST respond using the \`store_triage_result\` tool. Do not respond with text.`,
  );

  return sections.join('\n');
}

const STORE_TRIAGE_TOOL = {
  name: 'store_triage_result',
  description: 'Store the triage classification result for this message',
  input_schema: {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string',
        description: 'The triage category (e.g. needs_response, fyi, newsletter, cold_outreach, transactional, urgent, scheduling, or a custom category)',
      },
      confidence: {
        type: 'number',
        description: 'Confidence score between 0 and 1',
      },
      suggestedAction: {
        type: 'string',
        description: 'A concise description of the recommended action to take',
      },
      matchedPlaybookTriggers: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of playbook trigger strings that matched this message (empty array if none)',
      },
    },
    required: ['category', 'confidence', 'suggestedAction', 'matchedPlaybookTriggers'],
  },
};

function buildUserPrompt(message: InboundMessage): string {
  const parts: string[] = [
    `Channel: ${message.channel}`,
    `From: ${message.sender}`,
  ];
  if (message.subject) parts.push(`Subject: ${message.subject}`);
  if (message.threadId) parts.push(`Thread ID: ${message.threadId}`);
  parts.push(``, `Body:`, message.body);

  return `Classify this inbound message:\n\n${parts.join('\n')}`;
}

// ── Fallback classification ─────────────────────────────────────────

function buildFallbackResult(): TriageResult {
  return {
    category: 'needs_response',
    confidence: 0.3,
    suggestedAction: 'Review manually — LLM classification unavailable',
    matchedPlaybooks: [],
  };
}

// ── Core triage function ────────────────────────────────────────────

export async function triageMessage(
  message: InboundMessage,
  scopeId?: string,
): Promise<TriageResult> {
  // Step 1: Look up sender in contact graph
  const contact = findContactByAddress(message.channel, message.sender);

  // Step 2: Fetch matching playbooks
  const playbookMatches = fetchMatchingPlaybooks(message.channel, scopeId);

  // Step 3: Classify with LLM
  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.warn('No Anthropic API key available for triage classification, returning fallback');
    const result = buildFallbackResult();
    persistTriageResult(message, result, playbookMatches);
    return result;
  }

  let result: TriageResult;
  try {
    result = await classifyWithLLM(message, contact, playbookMatches, apiKey);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn({ err: errMsg }, 'Triage LLM call failed, returning fallback');
    result = buildFallbackResult();
  }

  // Step 4: Persist the result
  persistTriageResult(message, result, playbookMatches);

  return result;
}

async function classifyWithLLM(
  message: InboundMessage,
  contact: ContactWithChannels | null,
  playbookMatches: PlaybookMatch[],
  apiKey: string,
): Promise<TriageResult> {
  const client = new Anthropic({ apiKey });
  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout>;

  const systemPrompt = buildSystemPrompt(contact, playbookMatches);
  const userPrompt = buildUserPrompt(message);

  const apiCall = client.messages.create({
    model: TRIAGE_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    tools: [STORE_TRIAGE_TOOL],
    tool_choice: { type: 'tool' as const, name: 'store_triage_result' },
    messages: [{
      role: 'user' as const,
      content: userPrompt,
    }],
  }, { signal: abortController.signal });

  // Swallow the abort rejection that fires when the timeout wins the race
  apiCall.catch(() => {});
  const response = await Promise.race([
    apiCall.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(new Error('Triage classification LLM timeout'));
      }, TRIAGE_CLASSIFICATION_TIMEOUT_MS);
    }),
  ]);

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    log.warn('No tool_use block in triage response, returning fallback');
    return buildFallbackResult();
  }

  const input = toolBlock.input as {
    category?: string;
    confidence?: number;
    suggestedAction?: string;
    matchedPlaybookTriggers?: string[];
  };

  const matchedTriggers = new Set(
    Array.isArray(input.matchedPlaybookTriggers) ? input.matchedPlaybookTriggers : [],
  );

  // Map LLM-identified triggers back to the full playbook data
  const matchedPlaybooks = playbookMatches
    .filter(({ playbook }) => matchedTriggers.has(playbook.trigger))
    .map(({ playbook }) => ({
      trigger: playbook.trigger,
      action: playbook.action,
      autonomyLevel: playbook.autonomyLevel,
    }));

  const confidence = typeof input.confidence === 'number'
    ? Math.max(0, Math.min(1, input.confidence))
    : 0.5;

  return {
    category: typeof input.category === 'string' ? input.category : 'needs_response',
    confidence,
    suggestedAction: typeof input.suggestedAction === 'string'
      ? input.suggestedAction.slice(0, 500)
      : 'Review manually',
    matchedPlaybooks,
  };
}

// ── Persistence ─────────────────────────────────────────────────────

function persistTriageResult(
  message: InboundMessage,
  result: TriageResult,
  playbookMatches: PlaybookMatch[],
): void {
  try {
    const db = getDb();
    const matchedIds = playbookMatches
      .filter(({ playbook }) =>
        result.matchedPlaybooks.some((mp) => mp.trigger === playbook.trigger),
      )
      .map(({ id }) => id);

    db.insert(triageResults).values({
      id: uuid(),
      channel: message.channel,
      sender: message.sender,
      category: result.category,
      confidence: result.confidence,
      suggestedAction: result.suggestedAction,
      matchedPlaybookIds: matchedIds.length > 0 ? JSON.stringify(matchedIds) : null,
      messageId: (message.metadata?.messageId as string) ?? null,
      createdAt: Date.now(),
    }).run();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn({ err: errMsg }, 'Failed to persist triage result');
  }
}

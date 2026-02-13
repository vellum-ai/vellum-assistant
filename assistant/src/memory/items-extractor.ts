import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getConfig } from '../config/loader.js';
import type { MemoryExtractionConfig } from '../config/types.js';
import { getLogger } from '../util/logger.js';
import { enqueueMemoryJob } from './jobs-store.js';
import { extractTextFromStoredMessageContent } from './message-content.js';
import { getDb } from './db.js';
import { memoryItems, memoryItemSources, messages } from './schema.js';

const log = getLogger('memory-items-extractor');

export type MemoryItemKind =
  | 'preference'
  | 'profile'
  | 'project'
  | 'decision'
  | 'todo'
  | 'fact'
  | 'constraint'
  | 'relationship'
  | 'event'
  | 'opinion'
  | 'instruction';

interface ExtractedItem {
  kind: MemoryItemKind;
  subject: string;
  statement: string;
  confidence: number;
  importance: number;
  fingerprint: string;
}

const VALID_KINDS = new Set<string>([
  'preference', 'profile', 'project', 'decision', 'todo',
  'fact', 'constraint', 'relationship', 'event', 'opinion', 'instruction',
]);

const SUPERSEDE_KINDS = new Set<MemoryItemKind>(['decision', 'preference', 'constraint']);

// ── Semantic density gating ────────────────────────────────────────────
// Skip messages that are too short or consist of low-value filler.

const LOW_VALUE_PATTERNS = new Set([
  'ok', 'okay', 'k', 'sure', 'yes', 'no', 'yep', 'nope', 'yeah', 'nah',
  'thanks', 'thank you', 'ty', 'thx', 'thanks!', 'thank you!',
  'got it', 'understood', 'makes sense', 'sounds good', 'sounds great',
  'cool', 'nice', 'great', 'awesome', 'perfect', 'done', 'lgtm',
  'agreed', 'right', 'correct', 'exactly', 'yup', 'ack',
  'hm', 'hmm', 'hmmm', 'ah', 'oh', 'i see',
]);

function hasSemanticDensity(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 15) return false;
  const lower = trimmed.toLowerCase().replace(/[.!?,;:\s]+$/, '');
  if (LOW_VALUE_PATTERNS.has(lower)) return false;
  // Very short messages with only 1-2 words are typically not memorable
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 2) return false;
  return true;
}

// ── LLM-powered extraction ────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Given a message from a conversation, extract structured memory items that would be valuable to remember for future interactions.

Extract items in these categories:
- preference: User likes, dislikes, preferred approaches/tools/styles
- profile: Personal info (name, role, location, timezone, background)
- project: Project names, repos, tech stacks, architecture details
- decision: Choices made, approaches selected, trade-offs resolved
- todo: Action items, follow-ups, things to do later
- fact: Notable facts, definitions, technical details worth remembering
- constraint: Rules, requirements, things that must/must not be done
- relationship: Connections between people, teams, projects, systems
- event: Deadlines, milestones, meetings, releases, dates
- opinion: Viewpoints, assessments, evaluations of tools/approaches
- instruction: Explicit directives on how the assistant should behave

For each item, provide:
- kind: One of the categories above
- subject: A short label (2-8 words) identifying what this is about
- statement: The full factual statement to remember (1-2 sentences)
- confidence: How confident you are this is accurate (0.0-1.0)
- importance: How valuable this is to remember (0.0-1.0)
  - 1.0: Explicit user instructions about assistant behavior
  - 0.8-0.9: Personal facts, strong preferences, key decisions
  - 0.6-0.7: Project details, constraints, opinions
  - 0.3-0.5: Contextual details, minor preferences

Rules:
- Only extract genuinely memorable information. Skip pleasantries, filler, and transient discussion.
- Do NOT extract information about what tools the assistant used or what files it read — only extract substantive facts about the user, their projects, and their preferences.
- Prefer fewer high-quality items over many low-quality ones.
- If the message contains no memorable information, return an empty array.`;

interface LLMExtractedItem {
  kind: string;
  subject: string;
  statement: string;
  confidence: number;
  importance: number;
}

async function extractItemsWithLLM(
  text: string,
  extractionConfig: MemoryExtractionConfig,
): Promise<ExtractedItem[]> {
  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.debug('No Anthropic API key available for LLM extraction, falling back to pattern-based');
    return extractItemsPatternBased(text);
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await Promise.race([
      client.messages.create({
        model: extractionConfig.model,
        max_tokens: 1024,
        system: EXTRACTION_SYSTEM_PROMPT,
        tools: [{
          name: 'store_memory_items',
          description: 'Store extracted memory items from the message',
          input_schema: {
            type: 'object' as const,
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    kind: {
                      type: 'string',
                      enum: [...VALID_KINDS],
                      description: 'Category of memory item',
                    },
                    subject: {
                      type: 'string',
                      description: 'Short label (2-8 words) for what this is about',
                    },
                    statement: {
                      type: 'string',
                      description: 'Full factual statement to remember (1-2 sentences)',
                    },
                    confidence: {
                      type: 'number',
                      description: 'Confidence that this is accurate (0.0-1.0)',
                    },
                    importance: {
                      type: 'number',
                      description: 'How valuable this is to remember (0.0-1.0)',
                    },
                  },
                  required: ['kind', 'subject', 'statement', 'confidence', 'importance'],
                },
              },
            },
            required: ['items'],
          },
        }],
        tool_choice: { type: 'tool' as const, name: 'store_memory_items' },
        messages: [{ role: 'user' as const, content: text }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM extraction timeout')), 15000),
      ),
    ]);

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      log.warn('No tool_use block in LLM extraction response, falling back to pattern-based');
      return extractItemsPatternBased(text);
    }

    const input = toolBlock.input as { items?: LLMExtractedItem[] };
    if (!Array.isArray(input.items)) {
      log.warn('Invalid items in LLM extraction response, falling back to pattern-based');
      return extractItemsPatternBased(text);
    }

    const items: ExtractedItem[] = [];
    for (const raw of input.items) {
      if (!VALID_KINDS.has(raw.kind)) continue;
      if (!raw.subject || !raw.statement) continue;
      const subject = String(raw.subject).slice(0, 80);
      const statement = String(raw.statement).slice(0, 500);
      const confidence = clamp(Number(raw.confidence) || 0.5, 0, 1);
      const importance = clamp(Number(raw.importance) || 0.5, 0, 1);
      const normalized = `${raw.kind}|${subject.toLowerCase()}|${statement.toLowerCase()}`;
      const fingerprint = createHash('sha256').update(normalized).digest('hex');
      items.push({
        kind: raw.kind as MemoryItemKind,
        subject,
        statement,
        confidence,
        importance,
        fingerprint,
      });
    }

    return deduplicateItems(items);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'LLM extraction failed, falling back to pattern-based');
    return extractItemsPatternBased(text);
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export async function extractAndUpsertMemoryItemsForMessage(messageId: string): Promise<number> {
  const db = getDb();
  const message = db
    .select({
      id: messages.id,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();

  if (!message) return 0;

  const text = extractTextFromStoredMessageContent(message.content);
  if (!hasSemanticDensity(text)) {
    log.debug({ messageId }, 'Skipping extraction — message lacks semantic density');
    return 0;
  }

  const config = getConfig();
  const extractionConfig = config.memory.extraction;
  const extracted = extractionConfig.useLLM
    ? await extractItemsWithLLM(text, extractionConfig)
    : extractItemsPatternBased(text);

  if (extracted.length === 0) return 0;

  let upserted = 0;
  for (const item of extracted) {
    const now = Date.now();
    const seenAt = message.createdAt;
    const existing = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.fingerprint, item.fingerprint))
      .get();

    let memoryItemId: string;
    if (existing) {
      memoryItemId = existing.id;
      db.update(memoryItems)
        .set({
          status: 'active',
          confidence: Math.max(existing.confidence, item.confidence),
          importance: item.importance,
          lastSeenAt: Math.max(existing.lastSeenAt, seenAt),
        })
        .where(eq(memoryItems.id, existing.id))
        .run();
    } else {
      memoryItemId = uuid();
      db.insert(memoryItems).values({
        id: memoryItemId,
        kind: item.kind,
        subject: item.subject,
        statement: item.statement,
        status: 'active',
        confidence: item.confidence,
        importance: item.importance,
        fingerprint: item.fingerprint,
        firstSeenAt: message.createdAt,
        lastSeenAt: seenAt,
        lastUsedAt: null,
      }).run();
      upserted += 1;
    }

    if (SUPERSEDE_KINDS.has(item.kind)) {
      db.update(memoryItems)
        .set({ status: 'superseded' })
        .where(and(
          eq(memoryItems.kind, item.kind),
          eq(memoryItems.subject, item.subject),
          eq(memoryItems.status, 'active'),
          sql`${memoryItems.id} <> ${memoryItemId}`,
        ))
        .run();
    }

    db.insert(memoryItemSources).values({
      memoryItemId,
      messageId,
      evidence: item.statement.slice(0, 500),
      createdAt: now,
    }).onConflictDoNothing().run();

    enqueueMemoryJob('embed_item', { itemId: memoryItemId });
  }

  log.debug({ messageId, extracted: extracted.length, upserted }, 'Extracted memory items from message');
  return upserted;
}

// ── Pattern-based extraction (fallback) ────────────────────────────────

function extractItemsPatternBased(text: string): ExtractedItem[] {
  const sentences = text
    .split(/[\n\r]+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 500);

  const items: ExtractedItem[] = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const classification = classifySentence(lower);
    if (!classification) continue;
    const subject = inferSubject(sentence, classification.kind);
    const statement = sentence.replace(/\s+/g, ' ').trim();
    const normalized = `${classification.kind}|${subject.toLowerCase()}|${statement.toLowerCase()}`;
    const fingerprint = createHash('sha256').update(normalized).digest('hex');
    items.push({
      kind: classification.kind,
      subject,
      statement,
      confidence: classification.confidence,
      importance: classification.importance,
      fingerprint,
    });
  }

  return deduplicateItems(items);
}

function classifySentence(lower: string): { kind: MemoryItemKind; confidence: number; importance: number } | null {
  if (includesAny(lower, ['i prefer', 'prefer to', 'favorite', 'i like', 'i dislike'])) {
    return { kind: 'preference', confidence: 0.78, importance: 0.7 };
  }
  if (includesAny(lower, ['my name is', 'i am ', 'i work as', 'i live in', 'timezone'])) {
    return { kind: 'profile', confidence: 0.72, importance: 0.8 };
  }
  if (includesAny(lower, ['project', 'repository', 'repo', 'codebase'])) {
    return { kind: 'project', confidence: 0.68, importance: 0.6 };
  }
  if (includesAny(lower, ['we decided', 'decision', 'chosen approach', 'we will'])) {
    return { kind: 'decision', confidence: 0.75, importance: 0.7 };
  }
  if (includesAny(lower, ['todo', 'to do', 'next step', 'follow up', 'need to'])) {
    return { kind: 'todo', confidence: 0.74, importance: 0.6 };
  }
  if (includesAny(lower, ['must', 'cannot', 'should not', 'constraint', 'requirement'])) {
    return { kind: 'constraint', confidence: 0.7, importance: 0.7 };
  }
  if (includesAny(lower, ['remember', 'important', 'fact', 'noted'])) {
    return { kind: 'fact', confidence: 0.62, importance: 0.5 };
  }
  return null;
}

function inferSubject(sentence: string, kind: MemoryItemKind): string {
  const trimmed = sentence.trim();
  if (kind === 'project') {
    const match = trimmed.match(/(?:project|repo(?:sitory)?)\s+([A-Za-z0-9._/-]{2,80})/i);
    if (match) return match[1];
  }
  const words = trimmed.split(/\s+/).slice(0, 6).join(' ');
  return words.slice(0, 80);
}

function includesAny(text: string, needles: string[]): boolean {
  for (const needle of needles) {
    if (text.includes(needle)) return true;
  }
  return false;
}

// ── Helpers ────────────────────────────────────────────────────────────

function deduplicateItems(items: ExtractedItem[]): ExtractedItem[] {
  const seen = new Set<string>();
  const unique: ExtractedItem[] = [];
  for (const item of items) {
    if (seen.has(item.fingerprint)) continue;
    seen.add(item.fingerprint);
    unique.push(item);
  }
  return unique;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getLogger } from '../util/logger.js';
import { enqueueMemoryJob } from './jobs-store.js';
import { extractTextFromStoredMessageContent } from './message-content.js';
import { getDb } from './db.js';
import { memoryItems, memoryItemSources, messages } from './schema.js';

const log = getLogger('memory-items-extractor');

type MemoryItemKind = 'preference' | 'profile' | 'project' | 'decision' | 'todo' | 'fact' | 'constraint';

interface ExtractedItem {
  kind: MemoryItemKind;
  subject: string;
  statement: string;
  confidence: number;
  fingerprint: string;
}

const SUPERSEDE_KINDS = new Set<MemoryItemKind>(['decision', 'preference', 'constraint']);

export function extractAndUpsertMemoryItemsForMessage(messageId: string): number {
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
  const extracted = extractItems(text);
  if (extracted.length === 0) return 0;

  let upserted = 0;
  for (const item of extracted) {
    const now = Date.now();
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
          lastSeenAt: now,
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
        fingerprint: item.fingerprint,
        firstSeenAt: message.createdAt,
        lastSeenAt: now,
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

function extractItems(text: string): ExtractedItem[] {
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
      fingerprint,
    });
  }

  // Deduplicate within a single extraction run.
  const seen = new Set<string>();
  const unique: ExtractedItem[] = [];
  for (const item of items) {
    if (seen.has(item.fingerprint)) continue;
    seen.add(item.fingerprint);
    unique.push(item);
  }
  return unique;
}

function classifySentence(lower: string): { kind: MemoryItemKind; confidence: number } | null {
  if (includesAny(lower, ['i prefer', 'prefer to', 'favorite', 'i like', 'i dislike'])) {
    return { kind: 'preference', confidence: 0.78 };
  }
  if (includesAny(lower, ['my name is', 'i am ', 'i work as', 'i live in', 'timezone'])) {
    return { kind: 'profile', confidence: 0.72 };
  }
  if (includesAny(lower, ['project', 'repository', 'repo', 'codebase'])) {
    return { kind: 'project', confidence: 0.68 };
  }
  if (includesAny(lower, ['we decided', 'decision', 'chosen approach', 'we will'])) {
    return { kind: 'decision', confidence: 0.75 };
  }
  if (includesAny(lower, ['todo', 'to do', 'next step', 'follow up', 'need to'])) {
    return { kind: 'todo', confidence: 0.74 };
  }
  if (includesAny(lower, ['must', 'cannot', 'should not', 'constraint', 'requirement'])) {
    return { kind: 'constraint', confidence: 0.7 };
  }
  if (includesAny(lower, ['remember', 'important', 'fact', 'noted'])) {
    return { kind: 'fact', confidence: 0.62 };
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

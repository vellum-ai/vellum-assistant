import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import type { Message, ToolDefinition } from '../../../../providers/types.js';
import { getProvider } from '../../../../providers/registry.js';
import { getConfig } from '../../../../config/loader.js';
import { getDb } from '../../../../memory/db.js';
import { memoryItems } from '../../../../memory/schema.js';
import { enqueueMemoryJob } from '../../../../memory/jobs-store.js';
import * as gmail from '../client.js';
import type { GmailMessage, GmailMessagePart } from '../types.js';
import { withGmailToken, ok, err } from './shared.js';

const STYLE_EXTRACTION_SYSTEM_PROMPT = `You are a communication style analyst. Given a corpus of the user's sent emails, extract consistent patterns in their writing style.

Analyze these aspects:
- tone: Emotional register — warm, formal, casual, direct, enthusiastic, reserved
- greetings: How emails typically open (e.g., "Hi [name]," vs "Hey," vs no greeting)
- sign-offs: How emails typically close (e.g., "Best," vs "Thanks," vs "Cheers,")
- structure: Paragraph length, use of lists/bullets, typical email length
- vocabulary: Use of contractions, jargon, hedging language, exclamation marks
- formality_adaptation: How style shifts between different recipients (e.g., more formal with external contacts)

For each pattern you identify, provide:
- aspect: Which aspect this covers (tone, greetings, sign-offs, structure, vocabulary, formality_adaptation)
- summary: A concise description of the pattern (1-2 sentences, max 60 words)
- importance: How consistent/strong this pattern is (0.55-0.85)
- examples: 1-2 brief illustrative quotes from the emails

Also identify recurring contacts (people appearing in 3+ emails) and note how the user's tone shifts for them.

You MUST respond using the \`store_style_analysis\` tool. Do not respond with text.`;

const storeStyleAnalysisTool: ToolDefinition = {
  name: 'store_style_analysis',
  description: 'Store extracted writing style patterns and relationship observations',
  input_schema: {
    type: 'object',
    properties: {
      style_patterns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            aspect: {
              type: 'string',
              enum: ['tone', 'greetings', 'sign-offs', 'structure', 'vocabulary', 'formality_adaptation'],
            },
            summary: { type: 'string' },
            importance: { type: 'number' },
            examples: { type: 'array', items: { type: 'string' } },
          },
          required: ['aspect', 'summary', 'importance'],
        },
      },
      contact_observations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
            tone_note: { type: 'string' },
          },
          required: ['name', 'email', 'tone_note'],
        },
      },
    },
    required: ['style_patterns'],
  },
};

// ── Helpers ────────────────────────────────────────────────────────────

function getHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

function extractPlainTextBody(msg: GmailMessage): string | null {
  if (!msg.payload) return null;

  function walkParts(part: GmailMessagePart): string | null {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    if (part.parts) {
      for (const child of part.parts) {
        const result = walkParts(child);
        if (result) return result;
      }
    }
    return null;
  }

  return walkParts(msg.payload);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function upsertMemoryItem(opts: {
  kind: string;
  subject: string;
  statement: string;
  importance: number;
  scopeId: string;
}): void {
  const db = getDb();
  const now = Date.now();
  const normalized = `${opts.scopeId}|${opts.kind}|${opts.subject.toLowerCase()}|${opts.statement.toLowerCase()}`;
  const fingerprint = createHash('sha256').update(normalized).digest('hex');

  const existing = db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.fingerprint, fingerprint), eq(memoryItems.scopeId, opts.scopeId)))
    .get();

  if (existing) {
    db.update(memoryItems)
      .set({
        statement: opts.statement,
        status: 'active',
        importance: Math.max(existing.importance ?? 0, opts.importance),
        lastSeenAt: now,
        verificationState: 'assistant_inferred',
      })
      .where(eq(memoryItems.id, existing.id))
      .run();
    enqueueMemoryJob('embed_item', { itemId: existing.id });
  } else {
    const id = uuid();
    db.insert(memoryItems).values({
      id,
      kind: opts.kind,
      subject: opts.subject,
      statement: opts.statement,
      status: 'active',
      confidence: 0.8,
      importance: opts.importance,
      fingerprint,
      verificationState: 'assistant_inferred',
      scopeId: opts.scopeId,
      firstSeenAt: now,
      lastSeenAt: now,
      lastUsedAt: null,
    }).run();
    enqueueMemoryJob('embed_item', { itemId: id });
  }
}

// ── Main tool ──────────────────────────────────────────────────────────

export async function run(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  const maxEmails = Math.min(Math.max((input.max_emails as number) ?? 50, 1), 100);
  const recipientFilter = input.recipient_filter as string | undefined;

  return withGmailToken(async (token) => {
    // Fetch sent emails
    const query = recipientFilter ? `in:sent ${recipientFilter}` : 'in:sent';
    const listResult = await gmail.listMessages(token, query, maxEmails);

    if (!listResult.messages?.length) {
      return err('No sent emails found. Send some emails first, then try again.');
    }

    const messages = await gmail.batchGetMessages(
      token,
      listResult.messages.map((m) => m.id),
      'full',
    );

    // Build corpus from sent emails
    const corpusEntries: string[] = [];
    for (const msg of messages) {
      const body = extractPlainTextBody(msg);
      if (!body) continue;

      const to = getHeader(msg.payload?.headers, 'To') ?? 'unknown';
      const subject = getHeader(msg.payload?.headers, 'Subject') ?? '(no subject)';
      const truncatedBody = body.slice(0, 500);

      corpusEntries.push(`To: ${to}\nSubject: ${subject}\n\n${truncatedBody}`);
    }

    if (corpusEntries.length === 0) {
      return err('Could not extract text from any sent emails.');
    }

    const corpus = corpusEntries.map((e, i) => `--- Email ${i + 1} ---\n${e}`).join('\n\n');

    // Call the user's configured provider for style extraction
    const config = getConfig();
    const provider = getProvider(config.provider);
    const promptMessages: Message[] = [{
      role: 'user',
      content: [{ type: 'text', text: `Analyze these ${corpusEntries.length} sent emails for writing style patterns:\n\n${corpus}` }],
    }];

    const response = await provider.sendMessage(
      promptMessages,
      [storeStyleAnalysisTool],
      STYLE_EXTRACTION_SYSTEM_PROMPT,
      { signal: AbortSignal.timeout(30_000) },
    );

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      return err('Style analysis did not produce structured output. Try again.');
    }

    const result = toolBlock.input as {
      style_patterns?: Array<{ aspect: string; summary: string; importance: number; examples?: string[] }>;
      contact_observations?: Array<{ name: string; email: string; tone_note: string }>;
    };

    if (!Array.isArray(result.style_patterns) || result.style_patterns.length === 0) {
      return err('No style patterns were extracted. Try with more emails.');
    }

    // Persist style items to memory
    const scopeId = context.memoryScopeId ?? 'default';
    let savedCount = 0;

    for (const pattern of result.style_patterns) {
      const subject = `email writing style: ${pattern.aspect}`;
      const importance = clamp(pattern.importance ?? 0.65, 0.55, 0.85);

      upsertMemoryItem({
        kind: 'style',
        subject,
        statement: pattern.summary.slice(0, 500),
        importance,
        scopeId,
      });
      savedCount++;
    }

    // Persist contact relationship items
    if (Array.isArray(result.contact_observations)) {
      for (const contact of result.contact_observations) {
        if (!contact.name || !contact.tone_note) continue;
        const contactEmail = contact.email || 'unknown';
        const subject = `email relationship: ${contact.name}`;
        upsertMemoryItem({
          kind: 'relationship',
          subject,
          statement: `${contact.name} (${contactEmail}): ${contact.tone_note}`.slice(0, 500),
          importance: 0.6,
          scopeId,
        });
        savedCount++;
      }
    }

    const aspects = result.style_patterns.map((p) => p.aspect).join(', ');
    const contactCount = result.contact_observations?.length ?? 0;
    const summary = [
      `Analyzed ${corpusEntries.length} sent emails.`,
      `Extracted ${result.style_patterns.length} style patterns (${aspects}).`,
      contactCount > 0 ? `Noted ${contactCount} recurring contact relationship(s).` : '',
      `Saved ${savedCount} memory items. Future email drafts will automatically reflect your writing style.`,
    ].filter(Boolean).join(' ');

    return ok(summary);
  });
}

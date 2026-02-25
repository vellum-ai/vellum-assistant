/**
 * LLM-powered email classification for inbox triage.
 * Works with metadata only (from, subject, snippet, labels) to keep token usage low.
 */

import { getConfiguredProvider, createTimeout, extractToolUse, userMessage } from '../providers/provider-send-message.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('email-classifier');

const CLASSIFICATION_MODEL_INTENT = 'latency-optimized' as const;
const CLASSIFICATION_TIMEOUT_MS = 30_000;

export type EmailCategory =
  | 'needs_reply'
  | 'fyi_only'
  | 'can_archive'
  | 'urgent'
  | 'newsletter'
  | 'promotional';

export interface EmailMetadata {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  labels: string[];
}

export interface ClassifiedEmail {
  id: string;
  category: EmailCategory;
  reasoning: string;
  suggestedAction: string;
  urgencyScore: number; // 0-1
}

export interface ClassificationResult {
  classifications: ClassifiedEmail[];
}

const VALID_CATEGORIES = new Set<EmailCategory>([
  'needs_reply', 'fyi_only', 'can_archive', 'urgent', 'newsletter', 'promotional',
]);

const SYSTEM_PROMPT = `You are an email triage system. Given email metadata (sender, subject, snippet, labels), classify each email into exactly one category:

- needs_reply: Requires a personal response from the user
- fyi_only: Informational, no action needed but worth reading
- can_archive: Safe to archive without reading (automated notifications, receipts, etc.)
- urgent: Time-sensitive and requires immediate attention
- newsletter: Regular newsletter or digest
- promotional: Marketing, sales, or promotional content

For each email, provide:
- category: One of the categories above
- reasoning: Brief explanation of the classification (1 sentence)
- suggestedAction: What the user should do (e.g., "Reply to confirm", "Archive", "Read later")
- urgencyScore: 0.0 (not urgent) to 1.0 (extremely urgent)

You MUST respond using the \`store_classifications\` tool. Do not respond with text.`;

const STORE_CLASSIFICATIONS_TOOL = {
  name: 'store_classifications',
  description: 'Store email classification results',
  input_schema: {
    type: 'object' as const,
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Email ID' },
            category: {
              type: 'string',
              enum: ['needs_reply', 'fyi_only', 'can_archive', 'urgent', 'newsletter', 'promotional'],
            },
            reasoning: { type: 'string', description: 'Brief classification reasoning' },
            suggested_action: { type: 'string', description: 'Suggested action for the user' },
            urgency_score: { type: 'number', description: 'Urgency score 0-1' },
          },
          required: ['id', 'category', 'reasoning', 'suggested_action', 'urgency_score'],
        },
      },
    },
    required: ['classifications'],
  },
};

function formatEmailsForPrompt(emails: EmailMetadata[]): string {
  return emails
    .map((e, i) => [
      `--- Email ${i + 1} (ID: ${e.id}) ---`,
      `From: ${e.from}`,
      `Subject: ${e.subject}`,
      `Snippet: ${e.snippet}`,
      `Labels: ${e.labels.join(', ') || 'none'}`,
    ].join('\n'))
    .join('\n\n');
}

export async function classifyEmails(
  emails: EmailMetadata[],
): Promise<ClassificationResult> {
  if (emails.length === 0) {
    return { classifications: [] };
  }

  const provider = getConfiguredProvider();
  if (!provider) {
    log.warn('Configured provider unavailable for email classification');
    return { classifications: [] };
  }

  const prompt = `Classify these ${emails.length} emails:\n\n${formatEmailsForPrompt(emails)}`;

  try {
    const { signal, cleanup } = createTimeout(CLASSIFICATION_TIMEOUT_MS);

    try {
      const response = await provider.sendMessage(
        [userMessage(prompt)],
        [STORE_CLASSIFICATIONS_TOOL],
        SYSTEM_PROMPT,
        {
          config: {
            modelIntent: CLASSIFICATION_MODEL_INTENT,
            max_tokens: 2048,
            tool_choice: { type: 'tool' as const, name: 'store_classifications' },
          },
          signal,
        },
      );
      cleanup();

      const toolBlock = extractToolUse(response);
      if (!toolBlock) {
        log.warn('No tool_use block in classification response');
        return { classifications: [] };
      }

      const input = toolBlock.input as {
        classifications?: Array<{
          id: string;
          category: string;
          reasoning: string;
          suggested_action: string;
          urgency_score: number;
        }>;
      };

      const classifications: ClassifiedEmail[] = (input.classifications ?? [])
        .filter((c) => VALID_CATEGORIES.has(c.category as EmailCategory))
        .map((c) => ({
          id: c.id,
          category: c.category as EmailCategory,
          reasoning: c.reasoning,
          suggestedAction: c.suggested_action,
          urgencyScore: Math.max(0, Math.min(1, c.urgency_score)),
        }));

      return { classifications };
    } finally {
      cleanup();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn({ err: message }, 'Email classification LLM call failed');
    return { classifications: [] };
  }
}

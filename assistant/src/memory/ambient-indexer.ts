import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import * as conversationStore from './conversation-store.js';
import { getConfig } from '../config/loader.js';
import { getDb } from './db.js';
import { conversations } from './schema.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('ambient-indexer');

/** Deterministic well-known ID for the ambient conversation so we never
 *  select the wrong conversation by mutable title. */
const AMBIENT_CONVERSATION_ID = '00000000-0000-4000-a000-000000000001';
const AMBIENT_CONVERSATION_TITLE = 'Ambient Observations';

const ANALYSIS_PROMPT = `You are an ambient screen observer for a macOS assistant. You receive OCR text captured from the user's screen along with the app name and window title.

Classify this observation into one of three categories:
- "ignore": The content is mundane, routine, or contains no useful information worth remembering (e.g. desktop wallpaper, empty screens, loading spinners, generic UI chrome).
- "observe": The content is noteworthy and worth storing for future reference (e.g. error messages, project names, configuration details, important emails, meeting notes, code snippets).
- "suggest": The content is actionable — something the user might want help with right now (e.g. an error that could be fixed, a task that could be automated, a reminder to follow up).

Respond with ONLY a JSON object (no markdown fencing) with these fields:
- "decision": one of "ignore", "observe", or "suggest"
- "summary": a brief 1-2 sentence summary of what was observed (omit if "ignore")
- "suggestion": a specific actionable suggestion for the user (only if "suggest")`;

export async function analyzeAndIndexAmbientObservation(
  ocrText: string,
  appName?: string,
  windowTitle?: string,
): Promise<{ decision: 'ignore' | 'observe' | 'suggest'; summary?: string; suggestion?: string }> {
  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    log.warn('No Anthropic API key available for ambient analysis');
    return { decision: 'ignore' };
  }

  const client = new Anthropic({ apiKey });

  const contextParts: string[] = [];
  if (appName) contextParts.push(`App: ${appName}`);
  if (windowTitle) contextParts.push(`Window: ${windowTitle}`);
  contextParts.push(`\nScreen content:\n${ocrText}`);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `${ANALYSIS_PROMPT}\n\n${contextParts.join('\n')}`,
    }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    log.warn('No text response from ambient analysis');
    return { decision: 'ignore' };
  }

  let result: { decision: 'ignore' | 'observe' | 'suggest'; summary?: string; suggestion?: string };
  try {
    result = JSON.parse(textBlock.text);
  } catch {
    log.warn({ text: textBlock.text }, 'Failed to parse ambient analysis response as JSON');
    return { decision: 'ignore' };
  }

  if (!['ignore', 'observe', 'suggest'].includes(result.decision)) {
    log.warn({ decision: result.decision }, 'Invalid ambient analysis decision');
    return { decision: 'ignore' };
  }

  if (result.decision === 'ignore') {
    return { decision: 'ignore' };
  }

  // Store the observation as a message in a dedicated ambient conversation
  const conversationId = getOrCreateAmbientConversation();

  const contentParts: string[] = [];
  if (appName) contentParts.push(`[${appName}]`);
  if (windowTitle) contentParts.push(`${windowTitle}`);
  if (result.summary) contentParts.push(result.summary);
  if (result.suggestion) contentParts.push(`Suggestion: ${result.suggestion}`);

  const messageContent = JSON.stringify([{ type: 'text', text: contentParts.join(' - ') }]);
  // addMessage() automatically indexes the message for memory retrieval
  const message = conversationStore.addMessage(conversationId, 'user', messageContent);

  log.info({ decision: result.decision, conversationId, messageId: message.id }, 'Indexed ambient observation');

  return result;
}

function getOrCreateAmbientConversation(): string {
  const db = getDb();
  const existing = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, AMBIENT_CONVERSATION_ID))
    .limit(1)
    .get();

  if (existing) {
    return existing.id;
  }

  const now = Date.now();
  db.insert(conversations)
    .values({
      id: AMBIENT_CONVERSATION_ID,
      title: AMBIENT_CONVERSATION_TITLE,
      createdAt: now,
      updatedAt: now,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextCompactedMessageCount: 0,
    })
    .run();

  log.info({ conversationId: AMBIENT_CONVERSATION_ID }, 'Created ambient observations conversation');
  return AMBIENT_CONVERSATION_ID;
}

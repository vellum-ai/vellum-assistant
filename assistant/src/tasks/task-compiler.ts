import { eq } from 'drizzle-orm';
import { getDb } from '../memory/db.js';
import { messages as messagesTable } from '../memory/schema.js';
import { createTask } from './task-store.js';
import type { Task } from './task-store.js';
import { truncate } from '../util/truncate.js';
import { parseJsonSafe } from '../util/json.js';
import { sanitizeToolList } from './tool-sanitizer.js';

/** Output schema for the task compiler. */
export interface CompiledTask {
  title: string;
  template: string;
  inputSchema: Record<string, unknown> | null;
  contextFlags: string[];
  requiredTools: string[];
}

/**
 * Extract a task template (reusable definition) from a conversation's message history.
 *
 * Pattern-based extraction (v1) that:
 * 1. Reads the conversation messages
 * 2. Identifies the user's original request (first user message)
 * 3. Identifies which tools were used (from assistant tool_use messages)
 * 4. Builds a template from the original request
 * 5. Extracts likely input variables (file paths, URLs, quoted strings)
 */
export function compileTaskFromConversation(conversationId: string): CompiledTask {
  const db = getDb();
  const msgs = db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .all();

  if (msgs.length === 0) {
    throw new Error(`No messages found for conversation: ${conversationId}`);
  }

  // Find the first user message to use as the template basis
  const firstUserMsg = msgs.find((m) => m.role === 'user');
  if (!firstUserMsg) {
    throw new Error(`No user messages found in conversation: ${conversationId}`);
  }

  // Extract user message text content
  const userText = extractTextContent(firstUserMsg.content);

  // Extract unique tool names from assistant messages.
  const requiredTools = sanitizeToolList(extractToolNames(msgs));

  // Build template with placeholder substitutions
  const { template, properties } = buildTemplate(userText);

  // Build JSON Schema for extracted placeholders
  const inputSchema =
    Object.keys(properties).length > 0
      ? { type: 'object' as const, properties }
      : null;

  // Derive title from the first user message (truncated to 60 chars)
  const title = deriveTitle(userText);

  return {
    title,
    template,
    inputSchema,
    contextFlags: [],
    requiredTools,
  };
}

/**
 * Save a compiled task to the database.
 */
export function saveCompiledTask(compiled: CompiledTask, conversationId: string): Task {
  return createTask({
    title: compiled.title,
    template: compiled.template,
    inputSchema: compiled.inputSchema ?? undefined,
    contextFlags: compiled.contextFlags,
    requiredTools: compiled.requiredTools,
    createdFromConversationId: conversationId,
  });
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Extract plain text from a message content field. Content may be a plain
 * string or a JSON array of Anthropic content blocks.
 */
function extractTextContent(content: string): string {
  const parsed = parseJsonSafe(content);
  if (Array.isArray(parsed)) {
    return parsed
      .filter((block: Record<string, unknown>) => block.type === 'text')
      .map((block: Record<string, unknown>) => block.text as string)
      .join('\n');
  }
  return content;
}

/**
 * Extract unique tool names from assistant messages that contain tool_use blocks.
 */
function extractToolNames(
  msgs: { role: string; content: string }[],
): string[] {
  const tools = new Set<string>();

  for (const msg of msgs) {
    if (msg.role !== 'assistant') continue;

    const parsed = parseJsonSafe(msg.content);
    if (!Array.isArray(parsed)) continue;

    for (const block of parsed) {
      if (
        block &&
        typeof block === 'object' &&
        block.type === 'tool_use' &&
        typeof block.name === 'string'
      ) {
        tools.add(block.name);
      }
    }
  }

  return [...tools];
}

/**
 * Build a template from user text by replacing variable-looking parts
 * with mustache-style placeholders.
 *
 * Returns the template string and a map of property schemas for the
 * identified placeholders.
 */
function buildTemplate(text: string): {
  template: string;
  properties: Record<string, { type: string; description: string }>;
} {
  const properties: Record<string, { type: string; description: string }> = {};
  let template = text;
  let urlIndex = 0;
  let filePathIndex = 0;

  // Replace URLs first so they don't get partially matched by file path regex
  template = template.replace(
    /https?:\/\/[^\s)>]+/g,
    () => {
      const key = urlIndex === 0 ? 'url' : `url_${urlIndex}`;
      urlIndex++;
      properties[key] = {
        type: 'string',
        description: 'The URL to use',
      };
      return `{{${key}}}`;
    },
  );

  // Replace absolute file paths (e.g. /Users/foo/bar.txt, ~/docs/file)
  // Only match paths starting with / or ~/ that have at least two segments
  template = template.replace(
    /(?:~\/|\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+)/g,
    () => {
      const key = filePathIndex === 0 ? 'file_path' : `file_path_${filePathIndex}`;
      filePathIndex++;
      properties[key] = {
        type: 'string',
        description: 'The file path to operate on',
      };
      return `{{${key}}}`;
    },
  );

  return { template, properties };
}

/**
 * Derive a short title from the user's first message.
 * Truncates to 60 characters with ellipsis if needed.
 */
function deriveTitle(text: string): string {
  // Take the first line and trim whitespace
  const firstLine = text.split('\n')[0].trim();
  return truncate(firstLine, 60);
}

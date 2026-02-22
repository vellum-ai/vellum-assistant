import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { parseChatGPTExport } from '../../../../import/chatgpt.js';
import { createConversation, addMessage } from '../../../../memory/conversation-store.js';
import { getDb } from '../../../../memory/db.js';
import { conversations, messages as messagesTable, conversationKeys } from '../../../../memory/schema.js';

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const filePath = input.file_path as string;
  const dryRun = (input.dry_run as boolean) ?? false;

  if (!filePath) {
    return { content: 'Error: file_path is required', isError: true };
  }

  if (!existsSync(filePath)) {
    return { content: `Error: File not found: ${filePath}`, isError: true };
  }

  let imported;
  try {
    imported = await parseChatGPTExport(filePath);
  } catch (err) {
    return {
      content: `Error parsing export file: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  if (imported.length === 0) {
    return { content: 'No conversations found in the export file.', isError: false };
  }

  const totalMessages = imported.reduce((sum, c) => sum + c.messages.length, 0);

  if (dryRun) {
    const lines = [
      `Preview — would import:`,
      `  ${imported.length} conversation(s)`,
      `  ${totalMessages} message(s)`,
      ``,
      `Conversations:`,
    ];
    for (const conv of imported) {
      lines.push(`  - "${conv.title}" — ${conv.messages.length} messages`);
    }
    return { content: lines.join('\n'), isError: false };
  }

  const db = getDb();
  let importedCount = 0;
  let skippedCount = 0;
  let messageCount = 0;

  for (const conv of imported) {
    const convKey = `chatgpt:${conv.sourceId}`;

    // Check for duplicate
    const existing = db
      .select()
      .from(conversationKeys)
      .where(eq(conversationKeys.conversationKey, convKey))
      .get();

    if (existing) {
      skippedCount++;
      continue;
    }

    // Create the conversation
    const conversation = createConversation(conv.title);

    // Add all messages
    for (const msg of conv.messages) {
      addMessage(conversation.id, msg.role, JSON.stringify(msg.content));
    }

    // Override timestamps to match ChatGPT originals
    db.update(conversations)
      .set({ createdAt: conv.createdAt, updatedAt: conv.updatedAt })
      .where(eq(conversations.id, conversation.id))
      .run();

    // Update message timestamps to match ChatGPT originals
    const dbMessages = db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversation.id))
      .orderBy(messagesTable.createdAt)
      .all();

    for (let i = 0; i < dbMessages.length && i < conv.messages.length; i++) {
      db.update(messagesTable)
        .set({ createdAt: conv.messages[i].createdAt })
        .where(eq(messagesTable.id, dbMessages[i].id))
        .run();
    }

    // Store deduplication key
    db.insert(conversationKeys)
      .values({
        id: uuid(),
        conversationKey: convKey,
        conversationId: conversation.id,
        createdAt: Date.now(),
      })
      .run();

    importedCount++;
    messageCount += conv.messages.length;
  }

  const lines = [`Imported ${importedCount} conversation(s) with ${messageCount} message(s).`];
  if (skippedCount > 0) {
    lines.push(`Skipped ${skippedCount} already-imported conversation(s).`);
  }
  return { content: lines.join('\n'), isError: false };
}

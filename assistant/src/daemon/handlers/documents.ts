import type { HandlerContext } from './shared.js';
import type * as net from 'node:net';
import { getDb } from '../../memory/db.js';

import { writeFileSync } from 'node:fs';

/** Locally-defined types — removed from ipc-contract but still used by document handlers. */
interface DocumentSaveRequest {
  type: 'document_save_request';
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  wordCount: number;
}

interface DocumentLoadRequest {
  type: 'document_load_request';
  surfaceId: string;
}

interface DocumentListRequest {
  type: 'document_list_request';
  conversationId?: string;
}

/** Cast-through send for document messages that are no longer in the ServerMessage union. */
function sendDoc(ctx: HandlerContext, socket: net.Socket, msg: Record<string, unknown>): void {
  ctx.send(socket, msg as any);
}

export function handleDocumentSave(msg: DocumentSaveRequest, socket: net.Socket, ctx: HandlerContext): void {
  const logMsg = `[${new Date().toISOString()}] handleDocumentSave called: ${JSON.stringify({
    surfaceId: msg.surfaceId,
    conversationId: msg.conversationId,
    title: msg.title,
    contentLength: msg.content.length,
    wordCount: msg.wordCount,
  })}\n`;

  try {
    writeFileSync('/tmp/document-save-debug.log', logMsg, { flag: 'a' });
  } catch (e) {
    // Ignore logging errors
  }

  console.log('💾 [handleDocumentSave] Received save request:', {
    surfaceId: msg.surfaceId,
    conversationId: msg.conversationId,
    title: msg.title,
    contentLength: msg.content.length,
    wordCount: msg.wordCount,
  });

  try {
    writeFileSync('/tmp/document-save-debug.log', `[${new Date().toISOString()}] Getting db...\n`, { flag: 'a' });
    const db = getDb();
    // Get the raw SQLite client from Drizzle
    const sqlite = (db as any).$client;
    const now = Date.now();

    writeFileSync('/tmp/document-save-debug.log', `[${new Date().toISOString()}] Running sqlite.run()...\n`, { flag: 'a' });
    // Upsert document (insert or update if exists)
    sqlite.run(
      `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(surface_id) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         word_count = excluded.word_count,
         updated_at = excluded.updated_at`,
      [msg.surfaceId, msg.conversationId, msg.title, msg.content, msg.wordCount, now, now]
    );

    writeFileSync('/tmp/document-save-debug.log', `[${new Date().toISOString()}] db.run() completed, sending response...\n`, { flag: 'a' });
    sendDoc(ctx, socket, {
      type: 'document_save_response',
      surfaceId: msg.surfaceId,
      success: true,
    });

    writeFileSync('/tmp/document-save-debug.log', `[${new Date().toISOString()}] Response sent successfully\n`, { flag: 'a' });

    console.log(`[documents] Saved document: ${msg.surfaceId} - "${msg.title}"`);
  } catch (error) {
    console.error('[documents] Save error:', error);
    sendDoc(ctx, socket, {
      type: 'document_save_response',
      surfaceId: msg.surfaceId,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export function handleDocumentLoad(msg: DocumentLoadRequest, socket: net.Socket, ctx: HandlerContext): void {
  try {
    const db = getDb();
    const sqlite = (db as any).$client;

    const result = sqlite.query(`
      SELECT surface_id, conversation_id, title, content, word_count, created_at, updated_at
      FROM documents
      WHERE surface_id = ?
    `).get(msg.surfaceId) as {
      surface_id: string;
      conversation_id: string;
      title: string;
      content: string;
      word_count: number;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (result) {
      sendDoc(ctx, socket, {
        type: 'document_load_response',
        surfaceId: result.surface_id,
        conversationId: result.conversation_id,
        title: result.title,
        content: result.content,
        wordCount: result.word_count,
        createdAt: result.created_at,
        updatedAt: result.updated_at,
        success: true,
      });
      console.log(`[documents] Loaded document: ${msg.surfaceId}`);
    } else {
      sendDoc(ctx, socket, {
        type: 'document_load_response',
        surfaceId: msg.surfaceId,
        conversationId: '',
        title: '',
        content: '',
        wordCount: 0,
        createdAt: 0,
        updatedAt: 0,
        success: false,
        error: 'Document not found',
      });
      console.log(`[documents] Document not found: ${msg.surfaceId}`);
    }
  } catch (error) {
    console.error('[documents] Load error:', error);
    sendDoc(ctx, socket, {
      type: 'document_load_response',
      surfaceId: msg.surfaceId,
      conversationId: '',
      title: '',
      content: '',
      wordCount: 0,
      createdAt: 0,
      updatedAt: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export function handleDocumentList(msg: DocumentListRequest, socket: net.Socket, ctx: HandlerContext): void {
  try {
    const db = getDb();
    const sqlite = (db as any).$client;

    let query = `
      SELECT surface_id, conversation_id, title, word_count, created_at, updated_at
      FROM documents
    `;
    const params: string[] = [];

    if (msg.conversationId) {
      query += ' WHERE conversation_id = ?';
      params.push(msg.conversationId);
    }

    query += ' ORDER BY updated_at DESC';

    const results = sqlite.query(query).all(...params) as Array<{
      surface_id: string;
      conversation_id: string;
      title: string;
      word_count: number;
      created_at: number;
      updated_at: number;
    }>;

    sendDoc(ctx, socket, {
      type: 'document_list_response',
      documents: results.map((row) => ({
        surfaceId: row.surface_id,
        conversationId: row.conversation_id,
        title: row.title,
        wordCount: row.word_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });

    console.log(`[documents] Listed ${results.length} documents`);
  } catch (error) {
    console.error('[documents] List error:', error);
    sendDoc(ctx, socket, {
      type: 'document_list_response',
      documents: [],
    });
  }
}

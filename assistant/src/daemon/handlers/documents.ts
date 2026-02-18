import type { DocumentSaveRequest, DocumentLoadRequest, DocumentListRequest } from '../ipc-contract.js';
import type { HandlerContext } from './shared.js';
import type * as net from 'node:net';
import { getDb } from '../../memory/db.js';

import { writeFileSync } from 'node:fs';

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
    ctx.send(socket, {
      type: 'document_save_response',
      surfaceId: msg.surfaceId,
      success: true,
    });

    writeFileSync('/tmp/document-save-debug.log', `[${new Date().toISOString()}] Response sent successfully\n`, { flag: 'a' });

    console.log(`[documents] Saved document: ${msg.surfaceId} - "${msg.title}"`);
  } catch (error) {
    console.error('[documents] Save error:', error);
    ctx.send(socket, {
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

    const result = db.get(/*sql*/ `
      SELECT surface_id, conversation_id, title, content, word_count, created_at, updated_at
      FROM documents
      WHERE surface_id = ?
    `, [msg.surfaceId]) as {
      surface_id: string;
      conversation_id: string;
      title: string;
      content: string;
      word_count: number;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (result) {
      ctx.send(socket, {
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
      ctx.send(socket, {
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
    ctx.send(socket, {
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

    let query = /*sql*/ `
      SELECT surface_id, conversation_id, title, word_count, created_at, updated_at
      FROM documents
    `;
    const params: string[] = [];

    if (msg.conversationId) {
      query += ' WHERE conversation_id = ?';
      params.push(msg.conversationId);
    }

    query += ' ORDER BY updated_at DESC';

    const results = db.all(query, params) as Array<{
      surface_id: string;
      conversation_id: string;
      title: string;
      word_count: number;
      created_at: number;
      updated_at: number;
    }>;

    ctx.send(socket, {
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
    ctx.send(socket, {
      type: 'document_list_response',
      documents: [],
    });
  }
}

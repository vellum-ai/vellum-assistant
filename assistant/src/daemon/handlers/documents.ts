import type { HandlerContext } from './shared.js';
import type { DocumentSaveRequest, DocumentLoadRequest, DocumentListRequest } from '../ipc-protocol.js';
import type * as net from 'node:net';
import type { Database } from 'bun:sqlite';
import { getDb } from '../../memory/db.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('documents');

export function handleDocumentSave(msg: DocumentSaveRequest, socket: net.Socket, ctx: HandlerContext): void {
  log.info({
    surfaceId: msg.surfaceId,
    conversationId: msg.conversationId,
    title: msg.title,
    contentLength: msg.content.length,
    wordCount: msg.wordCount,
  }, 'Received save request');

  try {
    const db = getDb();
    // Get the raw SQLite client from Drizzle
    const sqlite = (db as unknown as { $client: Database }).$client;
    const now = Date.now();

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

    ctx.send(socket, {
      type: 'document_save_response',
      surfaceId: msg.surfaceId,
      success: true,
    });

    log.info({ surfaceId: msg.surfaceId, title: msg.title }, 'Saved document');
  } catch (error) {
    log.error({ err: error, surfaceId: msg.surfaceId }, 'Save error');
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
    const sqlite = (db as unknown as { $client: Database }).$client;

    const result = sqlite.prepare(/*sql*/ `
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
      log.info({ surfaceId: msg.surfaceId }, 'Loaded document');
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
      log.info({ surfaceId: msg.surfaceId }, 'Document not found');
    }
  } catch (error) {
    log.error({ err: error, surfaceId: msg.surfaceId }, 'Load error');
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
    const sqlite = (db as unknown as { $client: Database }).$client;

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

    const results = sqlite.prepare(query).all(...params) as Array<{
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

    log.info({ count: results.length }, 'Listed documents');
  } catch (error) {
    log.error({ err: error }, 'List error');
    ctx.send(socket, {
      type: 'document_list_response',
      documents: [],
    });
  }
}

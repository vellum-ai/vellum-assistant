import type * as net from "node:net";

import {
  listDocuments,
  loadDocument,
  saveDocument,
} from "../../runtime/routes/documents-routes.js";
import { getLogger } from "../../util/logger.js";
import type {
  DocumentListRequest,
  DocumentLoadRequest,
  DocumentSaveRequest,
} from "../ipc-protocol.js";
import type { HandlerContext } from "./shared.js";
import { defineHandlers } from "./shared.js";

const log = getLogger("documents");

export function handleDocumentSave(
  msg: DocumentSaveRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  log.info(
    {
      surfaceId: msg.surfaceId,
      conversationId: msg.conversationId,
      title: msg.title,
      contentLength: msg.content.length,
      wordCount: msg.wordCount,
    },
    "Received save request",
  );

  const result = saveDocument({
    surfaceId: msg.surfaceId,
    conversationId: msg.conversationId,
    title: msg.title,
    content: msg.content,
    wordCount: msg.wordCount,
  });

  if (result.success) {
    ctx.send(socket, {
      type: "document_save_response",
      surfaceId: msg.surfaceId,
      success: true,
    });
  } else {
    ctx.send(socket, {
      type: "document_save_response",
      surfaceId: msg.surfaceId,
      success: false,
      error: result.error,
    });
  }
}

export function handleDocumentLoad(
  msg: DocumentLoadRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const result = loadDocument(msg.surfaceId);

  if (result.success) {
    ctx.send(socket, {
      type: "document_load_response",
      surfaceId: result.surfaceId,
      conversationId: result.conversationId,
      title: result.title,
      content: result.content,
      wordCount: result.wordCount,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      success: true,
    });
  } else {
    ctx.send(socket, {
      type: "document_load_response",
      surfaceId: msg.surfaceId,
      conversationId: "",
      title: "",
      content: "",
      wordCount: 0,
      createdAt: 0,
      updatedAt: 0,
      success: false,
      error: result.error,
    });
  }
}

export function handleDocumentList(
  msg: DocumentListRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const documents = listDocuments(msg.conversationId);
  ctx.send(socket, {
    type: "document_list_response",
    documents,
  });
}

export const documentHandlers = defineHandlers({
  document_save: handleDocumentSave,
  document_load: handleDocumentLoad,
  document_list: handleDocumentList,
});

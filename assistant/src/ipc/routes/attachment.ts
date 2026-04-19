/**
 * IPC routes for attachment operations.
 *
 * Exposes register and lookup operations so CLI commands and external
 * processes can interact with the attachment store.
 *
 * Each operation is registered under both a slash-style method name
 * (e.g. `attachment/register`) and an underscore alias (`attachment_register`)
 * for ergonomics.
 */

import { statSync } from "node:fs";
import { basename } from "node:path";

import { z } from "zod";

import {
  getFilePathBySourcePath,
  uploadFileBackedAttachment,
} from "../../memory/attachments-store.js";
import type { IpcRoute } from "../cli-server.js";

// -- Param schemas --------------------------------------------------------

const AttachmentRegisterParams = z.object({
  path: z.string().min(1),
  mimeType: z.string().min(1),
  filename: z.string().optional(),
});

const AttachmentLookupParams = z.object({
  sourcePath: z.string().min(1),
  conversationId: z.string().min(1),
});

// -- Handlers -------------------------------------------------------------

function handleAttachmentRegister(params?: Record<string, unknown>) {
  const { path, mimeType, filename } = AttachmentRegisterParams.parse(params);

  let sizeBytes: number;
  try {
    const stat = statSync(path);
    sizeBytes = stat.size;
  } catch {
    throw new Error(`File not found: ${path}`);
  }

  const resolvedFilename = filename ?? basename(path);
  return uploadFileBackedAttachment(
    resolvedFilename,
    mimeType,
    path,
    sizeBytes,
  );
}

function handleAttachmentLookup(params?: Record<string, unknown>) {
  const { sourcePath, conversationId } = AttachmentLookupParams.parse(params);

  const result = getFilePathBySourcePath(sourcePath, conversationId);
  if (result === null) {
    throw new Error(
      `No attachment found for source path: ${sourcePath} in conversation ${conversationId}. Run 'assistant attachment register' to register a file first.`,
    );
  }

  return { filePath: result };
}

// -- Route definitions ----------------------------------------------------

export const attachmentRegisterRoute: IpcRoute = {
  method: "attachment/register",
  handler: handleAttachmentRegister,
};

const attachmentRegisterAliasRoute: IpcRoute = {
  method: "attachment_register",
  handler: handleAttachmentRegister,
};

export const attachmentLookupRoute: IpcRoute = {
  method: "attachment/lookup",
  handler: handleAttachmentLookup,
};

const attachmentLookupAliasRoute: IpcRoute = {
  method: "attachment_lookup",
  handler: handleAttachmentLookup,
};

/** All attachment IPC routes (canonical + aliases). */
export const attachmentRoutes: IpcRoute[] = [
  attachmentRegisterRoute,
  attachmentRegisterAliasRoute,
  attachmentLookupRoute,
  attachmentLookupAliasRoute,
];

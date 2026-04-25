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

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import { z } from "zod";

import {
  getFilePathBySourcePath,
  uploadFileBackedAttachment,
  validateAttachmentUpload,
} from "../../memory/attachments-store.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { IpcRoute } from "../assistant-server.js";

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

// -- Path validation ------------------------------------------------------

/**
 * Verify that a resolved path is within the workspace directory.
 * Resolves symlinks on the nearest existing ancestor to prevent
 * symlink-based escapes.
 */
function assertWithinWorkspace(filePath: string): string {
  const workspaceDir = getWorkspaceDir();

  let realWorkspace: string;
  try {
    realWorkspace = realpathSync(workspaceDir);
  } catch {
    realWorkspace = workspaceDir;
  }

  const resolved = resolve(filePath);

  // Walk up to the nearest existing ancestor and resolve symlinks.
  let realResolved = resolved;
  let current = resolved;
  const trailing: string[] = [];
  while (current !== dirname(current)) {
    try {
      const real = realpathSync(current);
      realResolved = trailing.length > 0
        ? resolve(real, ...trailing)
        : real;
      break;
    } catch {
      trailing.unshift(basename(current));
      current = dirname(current);
    }
  }

  const rel = relative(realWorkspace, realResolved);
  if (rel.startsWith("..") || resolve(realWorkspace, rel) !== realResolved) {
    throw new Error(
      `Path must be within the workspace directory. Got: ${filePath}`,
    );
  }

  return resolved;
}

// -- Handlers -------------------------------------------------------------

function handleAttachmentRegister(params?: Record<string, unknown>) {
  const { path, mimeType, filename } = AttachmentRegisterParams.parse(params);

  const resolvedPath = assertWithinWorkspace(path);

  let sizeBytes: number;
  try {
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(
        `Path is not a regular file: ${path}. Provide a path to a file, not a directory.`,
      );
    }
    sizeBytes = stat.size;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Path is not")) {
      throw err;
    }
    throw new Error(`File not found: ${path}`);
  }

  const resolvedFilename = filename ?? basename(resolvedPath);

  const validation = validateAttachmentUpload(resolvedFilename, mimeType);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  return uploadFileBackedAttachment(
    resolvedFilename,
    mimeType,
    resolvedPath,
    sizeBytes,
  );
}

function handleAttachmentLookup(params?: Record<string, unknown>) {
  const { sourcePath, conversationId } = AttachmentLookupParams.parse(params);

  assertWithinWorkspace(sourcePath);

  const result = getFilePathBySourcePath(sourcePath, conversationId);
  if (result === null) {
    throw new Error(
      `No attachment found for source path: ${sourcePath} in conversation ${conversationId}. Run 'assistant attachment register' to register a file first.`,
    );
  }

  return { filePath: result };
}

// -- Route definitions ----------------------------------------------------

const attachmentRegisterRoute: IpcRoute = {
  method: "attachment/register",
  handler: handleAttachmentRegister,
};

const attachmentRegisterAliasRoute: IpcRoute = {
  method: "attachment_register",
  handler: handleAttachmentRegister,
};

const attachmentLookupRoute: IpcRoute = {
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

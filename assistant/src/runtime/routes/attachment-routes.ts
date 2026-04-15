/**
 * Route handlers for attachment upload, download, and deletion.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

import { z } from "zod";

import * as attachmentsStore from "../../memory/attachments-store.js";
import {
  AttachmentUploadError,
  getFilePathForAttachment,
  validateAttachmentUpload,
} from "../../memory/attachments-store.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

/** 150 MB — base64-encoded 100 MB attachment ≈ 134 MB plus JSON wrapper overhead. */
const MAX_UPLOAD_BODY_BYTES = 150 * 1024 * 1024;

/** 100 MB — maximum file size for file-backed uploads (matches client memorySafetyLimit). */
const MAX_FILE_BACKED_UPLOAD_BYTES = 100 * 1024 * 1024;

function resolveCanonicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function isPathWithinDirectory(filePath: string, allowedDir: string): boolean {
  return filePath === allowedDir || filePath.startsWith(allowedDir + sep);
}

function resolveAllowedAttachmentDirectories(): string[] {
  const workspaceAttachmentsDir = join(
    getWorkspaceDir(),
    "data",
    "attachments",
  );
  const recordingsDir = join(
    process.env.HOME ?? "",
    "Library/Application Support/vellum-assistant/recordings",
  );
  return [workspaceAttachmentsDir, recordingsDir].map((dir) => {
    try {
      return realpathSync(dir);
    } catch {
      return resolve(dir);
    }
  });
}

/**
 * Check if a resolved path is inside a conversation attachments subdirectory.
 * Matches: <conversationsDir>/<conversationId>/attachments/...
 */
function isConversationAttachmentPath(resolvedPath: string): boolean {
  const conversationsDir = join(getWorkspaceDir(), "conversations");
  let resolvedConversationsDir: string;
  try {
    resolvedConversationsDir = realpathSync(conversationsDir);
  } catch {
    resolvedConversationsDir = resolve(conversationsDir);
  }

  if (!isPathWithinDirectory(resolvedPath, resolvedConversationsDir)) {
    return false;
  }

  // Extract the relative path after conversations/ and verify it contains
  // an "attachments" segment: <conversationId>/attachments/...
  const relativePath = resolvedPath.slice(resolvedConversationsDir.length + 1);
  const segments = relativePath.split(sep);
  return segments.length >= 3 && segments[1] === "attachments";
}

export function resolveAllowedFileBackedAttachmentPath(
  filePath: string,
): string | null {
  const resolvedPath = resolveCanonicalPath(filePath);
  const allowedDirs = resolveAllowedAttachmentDirectories();
  if (allowedDirs.some((dir) => isPathWithinDirectory(resolvedPath, dir))) {
    return resolvedPath;
  }
  if (isConversationAttachmentPath(resolvedPath)) {
    return resolvedPath;
  }
  return null;
}

export async function handleUploadAttachment(req: Request): Promise<Response> {
  const rawBody = await req.arrayBuffer();
  if (rawBody.byteLength > MAX_UPLOAD_BODY_BYTES) {
    return httpError(
      "BAD_REQUEST",
      `Request body too large (limit: ${MAX_UPLOAD_BODY_BYTES} bytes)`,
      413,
    );
  }

  const body = JSON.parse(new TextDecoder().decode(rawBody)) as {
    filename?: string;
    mimeType?: string;
    data?: string;
    filePath?: string;
  };

  const { filename, mimeType, data, filePath } = body;

  if (!filename || typeof filename !== "string") {
    return httpError("BAD_REQUEST", "filename is required", 400);
  }

  if (!mimeType || typeof mimeType !== "string") {
    return httpError("BAD_REQUEST", "mimeType is required", 400);
  }

  const validation = validateAttachmentUpload(filename, mimeType);
  if (!validation.ok) {
    return httpError("UNPROCESSABLE_ENTITY", validation.error, 415);
  }

  let attachment: attachmentsStore.StoredAttachment;

  // File-backed upload: when filePath is provided and data is empty/missing,
  // register the attachment by path reference instead of requiring base64 data.
  // This supports:
  //   1. Desktop client file-picker uploads — the file is copied into the
  //      workspace attachments directory so it passes the directory allowlist.
  //   2. Retry of file-backed attachments (e.g. recordings) where the client
  //      no longer holds the inline data but the file still exists on disk.
  if (filePath && typeof filePath === "string" && (!data || data === "")) {
    let resolvedPath = resolveAllowedFileBackedAttachmentPath(filePath);

    // If the file isn't in an allowed directory, copy it into the workspace
    // attachments directory. This handles desktop client file-picker uploads
    // where the source file lives in an arbitrary user directory (e.g.
    // ~/Desktop, ~/Downloads). The copy lands in the allowlisted workspace
    // directory, preserving the security model.
    if (!resolvedPath) {
      const canonicalSource = resolveCanonicalPath(filePath);
      if (!existsSync(canonicalSource)) {
        return httpError("BAD_REQUEST", "filePath does not exist on disk", 400);
      }
      const sourceSize = statSync(canonicalSource).size;
      if (sourceSize > MAX_FILE_BACKED_UPLOAD_BYTES) {
        const sizeMB = Math.round(sourceSize / (1024 * 1024));
        return httpError(
          "BAD_REQUEST",
          `File is ${sizeMB} MB which exceeds the ${MAX_FILE_BACKED_UPLOAD_BYTES / (1024 * 1024)} MB upload limit`,
          413,
        );
      }
      const workspaceAttachmentsDir = join(
        getWorkspaceDir(),
        "data",
        "attachments",
      );
      mkdirSync(workspaceAttachmentsDir, { recursive: true });
      const destFilename = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const destPath = join(workspaceAttachmentsDir, destFilename);
      copyFileSync(canonicalSource, destPath);
      resolvedPath = resolveCanonicalPath(destPath);
    }

    if (!existsSync(resolvedPath)) {
      return httpError("BAD_REQUEST", "filePath does not exist on disk", 400);
    }
    const sizeBytes = statSync(resolvedPath).size;
    attachment = attachmentsStore.uploadFileBackedAttachment(
      filename,
      mimeType,
      resolvedPath,
      sizeBytes,
    );
  } else {
    if (!data || typeof data !== "string") {
      return httpError("BAD_REQUEST", "data (base64) is required", 400);
    }

    try {
      attachment = attachmentsStore.uploadAttachment(
        filename,
        mimeType,
        data,
        filePath ?? undefined,
      );
    } catch (err) {
      if (err instanceof AttachmentUploadError) {
        const status = err.message.startsWith("Attachment too large")
          ? 413
          : 400;
        return httpError("BAD_REQUEST", err.message, status);
      }
      throw err;
    }
  }

  return Response.json({
    id: attachment.id,
    original_filename: attachment.originalFilename,
    mime_type: attachment.mimeType,
    size_bytes: attachment.sizeBytes,
    kind: attachment.kind,
  });
}

export async function handleDeleteAttachment(req: Request): Promise<Response> {
  let body: { attachmentId?: string };
  try {
    body = (await req.json()) as { attachmentId?: string };
  } catch {
    return httpError("BAD_REQUEST", "Invalid or missing JSON body", 400);
  }

  const { attachmentId } = body;

  if (!attachmentId || typeof attachmentId !== "string") {
    return httpError("BAD_REQUEST", "attachmentId is required", 400);
  }

  const result = attachmentsStore.deleteAttachment(attachmentId);

  if (result === "not_found") {
    return httpError("NOT_FOUND", "Attachment not found", 404);
  }

  if (result === "still_referenced") {
    return httpError(
      "CONFLICT",
      "Attachment is still referenced by one or more messages",
      409,
    );
  }

  return new Response(null, { status: 204 });
}

function handleGetAttachment(attachmentId: string): Response {
  // Use the file_path column to detect file-backed attachments, not string
  // truthiness of dataBase64 (which would also match valid zero-byte uploads).
  const isFileBacked = !!getFilePathForAttachment(attachmentId);

  // Skip hydrating file data for file-backed attachments — clients should
  // fetch content via GET /attachments/:id/content (which validates the path
  // against the directory allowlist).
  const attachment = attachmentsStore.getAttachmentById(attachmentId, {
    hydrateFileData: !isFileBacked,
  });
  if (!attachment) {
    return httpError("NOT_FOUND", "Attachment not found", 404);
  }

  return Response.json({
    id: attachment.id,
    filename: attachment.originalFilename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    // Return null for file-backed attachments so the gateway's hydration check
    // (payload.data == null) triggers a fetch from the /content endpoint.
    data: isFileBacked ? null : attachment.dataBase64,
    // Signal to clients that they should fetch content via the /content endpoint
    ...(isFileBacked ? { fileBacked: true } : {}),
  });
}

/**
 * Serve raw file bytes for an attachment. For file-backed attachments this
 * streams from disk; for inline attachments it decodes the base64 data.
 * Supports Range headers for video seeking.
 */
export function handleGetAttachmentContent(
  attachmentId: string,
  req: Request,
): Response {
  // Check for file-backed attachment first so we can skip hydration — file-backed
  // content is served directly from disk via Bun.file, not from the hydrated base64.
  const filePath = getFilePathForAttachment(attachmentId);
  const isFileBacked = !!filePath;

  const attachment = attachmentsStore.getAttachmentById(attachmentId, {
    hydrateFileData: !isFileBacked,
  });
  if (!attachment) {
    return httpError("NOT_FOUND", "Attachment not found", 404);
  }
  if (filePath) {
    const resolvedPath = resolveAllowedFileBackedAttachmentPath(filePath);
    if (!resolvedPath) {
      return httpError("NOT_FOUND", "Attachment content not found", 404);
    }
    if (!existsSync(resolvedPath)) {
      return httpError("NOT_FOUND", "Recording file not found on disk", 404);
    }

    const file = Bun.file(resolvedPath);
    const rangeHeader = req.headers.get("Range");

    if (rangeHeader) {
      const fileSize = attachment.sizeBytes;
      let start: number;
      let end: number;

      // Parse suffix range: bytes=-N (last N bytes)
      const suffixMatch = rangeHeader.match(/bytes=-(\d+)/);
      if (suffixMatch) {
        const suffixLen = parseInt(suffixMatch[1]);
        start = Math.max(0, fileSize - suffixLen);
        end = fileSize - 1;
      } else {
        // Parse standard range: bytes=start-end
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (!match) {
          // Unparseable range — return full file
          return new Response(file, {
            headers: {
              "Content-Type": attachment.mimeType,
              "Content-Length": String(fileSize),
              "Accept-Ranges": "bytes",
            },
          });
        }
        start = parseInt(match[1]);
        end = match[2] ? parseInt(match[2]) : fileSize - 1;
      }

      // Clamp end to file size
      end = Math.min(end, fileSize - 1);

      // Reject invalid ranges
      if (start > end || start >= fileSize) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${fileSize}` },
        });
      }

      const slice = file.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Type": attachment.mimeType,
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
        },
      });
    }

    return new Response(file, {
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Length": String(attachment.sizeBytes),
        "Accept-Ranges": "bytes",
      },
    });
  }

  // Fall back to base64-decoded content for inline attachments
  if (!attachment.dataBase64) {
    return httpError("NOT_FOUND", "No content available", 404);
  }

  const buffer = Buffer.from(attachment.dataBase64, "base64");
  return new Response(buffer, {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(buffer.length),
      "Accept-Ranges": "bytes",
    },
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function attachmentRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "attachments",
      method: "POST",
      summary: "Upload attachment",
      description:
        "Upload an attachment as base64 data or file path reference.",
      tags: ["attachments"],
      requestBody: z.object({
        filename: z.string(),
        mimeType: z.string(),
        data: z.string().describe("Base64-encoded file data").optional(),
        filePath: z
          .string()
          .describe("On-disk file path (file-backed upload)")
          .optional(),
      }),
      responseBody: z.object({
        id: z.string(),
        original_filename: z.string(),
        mime_type: z.string(),
        size_bytes: z.number(),
        kind: z.string(),
      }),
      handler: async ({ req }) => handleUploadAttachment(req),
    },
    {
      endpoint: "attachments",
      method: "DELETE",
      summary: "Delete attachment",
      description: "Delete an attachment by ID.",
      tags: ["attachments"],
      requestBody: z.object({
        attachmentId: z.string(),
      }),
      handler: async ({ req }) => handleDeleteAttachment(req),
    },
    {
      endpoint: "attachments/:id/content",
      method: "GET",
      policyKey: "attachments/content",
      summary: "Get attachment content",
      description:
        "Serve raw file bytes for an attachment. Supports Range headers.",
      tags: ["attachments"],
      handler: ({ req, params }) => handleGetAttachmentContent(params.id, req),
    },
    {
      endpoint: "attachments/:id",
      method: "GET",
      policyKey: "attachments",
      summary: "Get attachment metadata",
      description:
        "Return metadata and optional base64 data for an attachment.",
      tags: ["attachments"],
      responseBody: z.object({
        id: z.string(),
        filename: z.string(),
        mimeType: z.string(),
        sizeBytes: z.number(),
        kind: z.string(),
        data: z.string().describe("Base64-encoded content"),
        fileBacked: z.boolean(),
      }),
      handler: ({ params }) => handleGetAttachment(params.id),
    },
  ];
}

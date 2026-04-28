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

import {
  deleteAttachment,
  getAttachmentById,
  getFilePathBySourcePath,
  StoredAttachment,
  uploadAttachment,
  uploadAttachmentFromBytes,
  uploadFileBackedAttachment,
} from "../../memory/attachments-store.js";
import {
  AttachmentUploadError,
  getFilePathForAttachment,
  validateAttachmentUpload,
} from "../../memory/attachments-store.js";
import { getWorkspaceDir } from "../../util/platform.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  RangeNotSatisfiableError,
  UnsupportedMediaTypeError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { RouteResponse } from "./types.js";

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

/** 100 MB — maximum file size for binary uploads (multipart / octet-stream). */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Build the standard JSON success payload for an uploaded attachment.
 */
function attachmentPayload(attachment: StoredAttachment) {
  return {
    id: attachment.id,
    original_filename: attachment.originalFilename,
    mime_type: attachment.mimeType,
    size_bytes: attachment.sizeBytes,
    kind: attachment.kind,
  };
}

// ---------------------------------------------------------------------------
// Content-Type dispatched upload handlers
// ---------------------------------------------------------------------------

/**
 * Handle multipart/form-data upload.
 * Expects: "file" (Blob), "filename" (string), "mimeType" (string).
 *
 * `gatewayTrustedSource` is true only when the caller is the gateway
 * service AND requested the bypass — see `handleUploadAttachmentRoute`.
 */
async function handleMultipartUpload(
  rawBody: Uint8Array,
  headers: Record<string, string>,
  gatewayTrustedSource: boolean,
) {
  const contentLength = headers["content-length"];
  if (contentLength && Number(contentLength) > MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeError(
      `File too large (limit: ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB)`,
    );
  }

  // Reconstruct a Request to use the platform's multipart parser.
  const syntheticReq = new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": headers["content-type"] ?? "" },
    body: rawBody.buffer as ArrayBuffer,
  });

  let formData: FormData;
  try {
    formData = await syntheticReq.formData();
  } catch {
    throw new BadRequestError("Invalid multipart form data");
  }

  const file = formData.get("file");
  if (!file || !(file instanceof Blob)) {
    throw new BadRequestError('Multipart upload requires a "file" field');
  }

  const filename = formData.get("filename");
  if (!filename || typeof filename !== "string") {
    throw new BadRequestError("filename field is required");
  }

  const mimeType = formData.get("mimeType");
  if (!mimeType || typeof mimeType !== "string") {
    throw new BadRequestError("mimeType field is required");
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeError(
      `File is ${Math.round(file.size / (1024 * 1024))} MB which exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit`,
    );
  }

  const trustedSource =
    gatewayTrustedSource && formData.get("trustedSource") === "true";

  const validation = validateAttachmentUpload(filename, mimeType, {
    trustedSource,
  });
  if (!validation.ok) {
    throw new UnsupportedMediaTypeError(validation.error);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const attachment = uploadAttachmentFromBytes(filename, mimeType, bytes);
  return attachmentPayload(attachment);
}

/**
 * Handle application/octet-stream upload.
 * filename and mimeType come from URL query params.
 *
 * See `handleMultipartUpload` for `gatewayTrustedSource` semantics.
 */
function handleOctetStreamUpload(
  rawBody: Uint8Array,
  headers: Record<string, string>,
  queryParams: Record<string, string>,
  gatewayTrustedSource: boolean,
) {
  const contentLength = headers["content-length"];
  if (contentLength && Number(contentLength) > MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeError(
      `File too large (limit: ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB)`,
    );
  }

  const filename = queryParams.filename;
  if (!filename || typeof filename !== "string") {
    throw new BadRequestError("filename query parameter is required");
  }

  const mimeType = queryParams.mimeType;
  if (!mimeType || typeof mimeType !== "string") {
    throw new BadRequestError("mimeType query parameter is required");
  }

  if (rawBody.byteLength > MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeError(
      `File is ${Math.round(rawBody.byteLength / (1024 * 1024))} MB which exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit`,
    );
  }

  const trustedSource =
    gatewayTrustedSource && queryParams.trustedSource === "true";

  const validation = validateAttachmentUpload(filename, mimeType, {
    trustedSource,
  });
  if (!validation.ok) {
    throw new UnsupportedMediaTypeError(validation.error);
  }

  const attachment = uploadAttachmentFromBytes(filename, mimeType, rawBody);
  return attachmentPayload(attachment);
}

/**
 * Handle application/json upload (existing behaviour — base64 or file-path).
 *
 * See `handleMultipartUpload` for `gatewayTrustedSource` semantics.
 */
function handleJsonUpload(
  body: Record<string, unknown>,
  rawBody: Uint8Array | undefined,
  gatewayTrustedSource: boolean,
) {
  if (rawBody && rawBody.byteLength > MAX_UPLOAD_BODY_BYTES) {
    throw new PayloadTooLargeError(
      `Request body too large (limit: ${MAX_UPLOAD_BODY_BYTES} bytes)`,
    );
  }

  const { filename, mimeType, data, filePath } = body as {
    filename?: string;
    mimeType?: string;
    data?: string;
    filePath?: string;
    trustedSource?: boolean;
  };

  if (!filename || typeof filename !== "string") {
    throw new BadRequestError("filename is required");
  }

  if (!mimeType || typeof mimeType !== "string") {
    throw new BadRequestError("mimeType is required");
  }

  const trustedSource =
    gatewayTrustedSource &&
    (body as { trustedSource?: boolean }).trustedSource === true;

  const validation = validateAttachmentUpload(filename, mimeType, {
    trustedSource,
  });
  if (!validation.ok) {
    throw new UnsupportedMediaTypeError(validation.error);
  }

  let attachment: StoredAttachment;

  if (filePath && typeof filePath === "string" && (!data || data === "")) {
    let resolvedPath = resolveAllowedFileBackedAttachmentPath(filePath);

    if (!resolvedPath) {
      const canonicalSource = resolveCanonicalPath(filePath);
      if (!existsSync(canonicalSource)) {
        throw new BadRequestError("filePath does not exist on disk");
      }
      const sourceSize = statSync(canonicalSource).size;
      if (sourceSize > MAX_FILE_BACKED_UPLOAD_BYTES) {
        const sizeMB = Math.round(sourceSize / (1024 * 1024));
        throw new PayloadTooLargeError(
          `File is ${sizeMB} MB which exceeds the ${MAX_FILE_BACKED_UPLOAD_BYTES / (1024 * 1024)} MB upload limit`,
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
      throw new BadRequestError("filePath does not exist on disk");
    }
    const sizeBytes = statSync(resolvedPath).size;
    attachment = uploadFileBackedAttachment(
      filename,
      mimeType,
      resolvedPath,
      sizeBytes,
    );
  } else {
    if (!data || typeof data !== "string") {
      throw new BadRequestError("data (base64) is required");
    }

    try {
      attachment = uploadAttachment(
        filename,
        mimeType,
        data,
        filePath ?? undefined,
      );
    } catch (err) {
      if (err instanceof AttachmentUploadError) {
        if (err.message.startsWith("Attachment too large")) {
          throw new PayloadTooLargeError(err.message);
        }
        throw new BadRequestError(err.message);
      }
      throw err;
    }
  }

  return attachmentPayload(attachment);
}

async function handleUploadAttachmentRoute(args: RouteHandlerArgs) {
  const { rawBody, headers = {}, queryParams = {}, body } = args;
  const contentType = headers["content-type"] ?? "";

  // The gateway sets x-vellum-principal-type when proxying authenticated
  // requests. Only gateway service principals can opt into the trusted
  // source bypass (skips attachment validation for channel-sourced files).
  const gatewayTrustedSource =
    headers["x-vellum-principal-type"] === "svc_gateway";

  if (contentType.includes("multipart/form-data") && rawBody) {
    return handleMultipartUpload(rawBody, headers, gatewayTrustedSource);
  }

  if (contentType.includes("application/octet-stream") && rawBody) {
    return handleOctetStreamUpload(
      rawBody,
      headers,
      queryParams,
      gatewayTrustedSource,
    );
  }

  // Default: JSON+base64 (existing behaviour)
  return handleJsonUpload(body ?? {}, rawBody, gatewayTrustedSource);
}

function handleDeleteAttachmentRoute({ body }: RouteHandlerArgs) {
  const attachmentId = body?.attachmentId as string | undefined;

  if (!attachmentId || typeof attachmentId !== "string") {
    throw new BadRequestError("attachmentId is required");
  }

  const result = deleteAttachment(attachmentId);

  if (result === "not_found") {
    throw new NotFoundError("Attachment not found");
  }

  if (result === "still_referenced") {
    throw new ConflictError(
      "Attachment is still referenced by one or more messages",
    );
  }

  return null;
}

function handleGetAttachmentRoute({ pathParams }: RouteHandlerArgs) {
  const attachmentId = pathParams!.id;
  // Use the file_path column to detect file-backed attachments, not string
  // truthiness of dataBase64 (which would also match valid zero-byte uploads).
  const isFileBacked = !!getFilePathForAttachment(attachmentId);

  // Skip hydrating file data for file-backed attachments — clients should
  // fetch content via GET /attachments/:id/content (which validates the path
  // against the directory allowlist).
  const attachment = getAttachmentById(attachmentId, {
    hydrateFileData: !isFileBacked,
  });
  if (!attachment) {
    throw new NotFoundError("Attachment not found");
  }

  return {
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
  };
}

/**
 * Serve raw file bytes for an attachment. For file-backed attachments this
 * streams from disk; for inline attachments it decodes the base64 data.
 * Supports Range headers for video seeking.
 */
function handleGetAttachmentContentRoute({
  pathParams,
  headers = {},
}: RouteHandlerArgs): RouteResponse {
  const attachmentId = pathParams!.id;
  const filePath = getFilePathForAttachment(attachmentId);
  const isFileBacked = !!filePath;

  const attachment = getAttachmentById(attachmentId, {
    hydrateFileData: !isFileBacked,
  });
  if (!attachment) {
    throw new NotFoundError("Attachment not found");
  }
  if (filePath) {
    const resolvedPath = resolveAllowedFileBackedAttachmentPath(filePath);
    if (!resolvedPath) {
      throw new NotFoundError("Attachment content not found");
    }
    if (!existsSync(resolvedPath)) {
      throw new NotFoundError("Recording file not found on disk");
    }

    const file = Bun.file(resolvedPath);
    const rangeHeader = headers["range"];

    if (rangeHeader) {
      const fileSize = attachment.sizeBytes;
      let start: number;
      let end: number;

      const suffixMatch = rangeHeader.match(/bytes=-(\d+)/);
      if (suffixMatch) {
        const suffixLen = parseInt(suffixMatch[1]);
        start = Math.max(0, fileSize - suffixLen);
        end = fileSize - 1;
      } else {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (!match) {
          // Unparseable range — return full file
          return new RouteResponse(file, {
            "Content-Type": attachment.mimeType,
            "Content-Length": String(fileSize),
            "Accept-Ranges": "bytes",
          });
        }
        start = parseInt(match[1]);
        end = match[2] ? parseInt(match[2]) : fileSize - 1;
      }

      end = Math.min(end, fileSize - 1);

      if (start > end || start >= fileSize) {
        throw new RangeNotSatisfiableError(`bytes */${fileSize}`);
      }

      const slice = file.slice(start, end + 1);
      return new RouteResponse(slice, {
        "Content-Type": attachment.mimeType,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      });
    }

    return new RouteResponse(file, {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(attachment.sizeBytes),
      "Accept-Ranges": "bytes",
    });
  }

  // Fall back to base64-decoded content for inline attachments
  if (!attachment.dataBase64) {
    throw new NotFoundError("No content available");
  }

  const buffer = Buffer.from(attachment.dataBase64, "base64");
  return new RouteResponse(buffer, {
    "Content-Type": attachment.mimeType,
    "Content-Length": String(buffer.length),
    "Accept-Ranges": "bytes",
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared (transport-agnostic) routes — served via HTTP + IPC
// ---------------------------------------------------------------------------

/**
 * Verify that a resolved path is within the workspace directory.
 * Resolves symlinks on the nearest existing ancestor to prevent
 * symlink-based escapes.
 */
function assertWithinWorkspace(filePath: string): string {
  const workspaceDir = getWorkspaceDir();
  const resolvedWorkspace = resolveCanonicalPath(workspaceDir);
  const resolved = resolve(filePath);

  // Walk up to the nearest existing ancestor and resolve symlinks.
  let current = resolved;
  const trailing: string[] = [];
  while (current !== join(current, "..")) {
    try {
      const real = realpathSync(current);
      const realResolved =
        trailing.length > 0 ? resolve(real, ...trailing) : real;
      if (!isPathWithinDirectory(realResolved, resolvedWorkspace)) {
        throw new BadRequestError(
          `Path must be within the workspace directory. Got: ${filePath}`,
        );
      }
      return resolved;
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      trailing.unshift(join(current).split(sep).pop()!);
      current = join(current, "..");
    }
  }

  throw new BadRequestError(
    `Path must be within the workspace directory. Got: ${filePath}`,
  );
}

function handleAttachmentRegister({ body = {} }: RouteHandlerArgs) {
  const { path, mimeType, filename } = body as {
    path?: string;
    mimeType?: string;
    filename?: string;
  };

  if (!path || typeof path !== "string") {
    throw new BadRequestError("path is required");
  }
  if (!mimeType || typeof mimeType !== "string") {
    throw new BadRequestError("mimeType is required");
  }

  const resolvedPath = assertWithinWorkspace(path);

  let sizeBytes: number;
  try {
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new BadRequestError(
        `Path is not a regular file: ${path}. Provide a path to a file, not a directory.`,
      );
    }
    sizeBytes = stat.size;
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new NotFoundError(`File not found: ${path}`);
  }

  const resolvedFilename =
    filename ?? resolvedPath.split(sep).pop() ?? "unknown";

  const validation = validateAttachmentUpload(resolvedFilename, mimeType);
  if (!validation.ok) {
    throw new BadRequestError(validation.error);
  }

  return uploadFileBackedAttachment(
    resolvedFilename,
    mimeType,
    resolvedPath,
    sizeBytes,
  );
}

function handleAttachmentLookup({ body = {} }: RouteHandlerArgs) {
  const { sourcePath, conversationId } = body as {
    sourcePath?: string;
    conversationId?: string;
  };

  if (!sourcePath || typeof sourcePath !== "string") {
    throw new BadRequestError("sourcePath is required");
  }
  if (!conversationId || typeof conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }

  assertWithinWorkspace(sourcePath);

  const result = getFilePathBySourcePath(sourcePath, conversationId);
  if (result === null) {
    throw new NotFoundError(
      `No attachment found for source path: ${sourcePath} in conversation ${conversationId}. Run 'assistant attachment register' to register a file first.`,
    );
  }

  return { filePath: result };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "attachment_content",
    endpoint: "attachments/:id/content",
    method: "GET",
    policyKey: "attachments/content",
    summary: "Get attachment content",
    description:
      "Serve raw file bytes for an attachment. Supports Range headers.",
    tags: ["attachments"],
    responseStatus: ({ headers }) => (headers?.["range"] ? "206" : "200"),
    additionalResponses: {
      "416": { description: "Range Not Satisfiable" },
    },
    handler: handleGetAttachmentContentRoute,
  },
  {
    operationId: "attachment_delete",
    endpoint: "attachments",
    method: "DELETE",
    summary: "Delete attachment",
    description: "Delete an attachment by ID.",
    tags: ["attachments"],
    requestBody: z.object({
      attachmentId: z.string(),
    }),
    responseStatus: "204",
    handler: handleDeleteAttachmentRoute,
  },
  {
    operationId: "attachment_get",
    endpoint: "attachments/:id",
    method: "GET",
    summary: "Get attachment metadata",
    description: "Return metadata and optional base64 data for an attachment.",
    tags: ["attachments"],
    responseBody: z.object({
      id: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number(),
      kind: z.string(),
      data: z.string().describe("Base64-encoded content").nullable(),
      fileBacked: z.boolean().optional(),
    }),
    handler: handleGetAttachmentRoute,
  },
  {
    operationId: "attachment_upload",
    endpoint: "attachments",
    method: "POST",
    summary: "Upload attachment",
    description:
      "Upload an attachment. Supports application/json (base64 data or file path reference), multipart/form-data (file + filename + mimeType fields), and application/octet-stream (raw bytes with filename and mimeType query params).",
    tags: ["attachments"],
    requestBody: z.object({
      filename: z.string(),
      mimeType: z.string(),
      data: z.string().describe("Base64-encoded file data").optional(),
      filePath: z
        .string()
        .describe("On-disk file path (file-backed upload)")
        .optional(),
      trustedSource: z
        .boolean()
        .describe(
          "Set by the gateway when the file came from a guardian-bound channel actor. Honored only when the request is authenticated as a gateway service token; ignored otherwise.",
        )
        .optional(),
    }),
    responseBody: z.object({
      id: z.string(),
      original_filename: z.string(),
      mime_type: z.string(),
      size_bytes: z.number(),
      kind: z.string(),
    }),
    handler: handleUploadAttachmentRoute,
  },
  {
    operationId: "attachment_register",
    endpoint: "attachments/register",
    method: "POST",
    summary: "Register a file-backed attachment",
    description:
      "Register an on-disk file as a file-backed attachment. The file must be within the workspace directory and must remain on disk for the lifetime of the attachment.",
    tags: ["attachments"],
    requestBody: z.object({
      path: z.string().describe("Absolute path to the file"),
      mimeType: z.string().describe("MIME type of the file"),
      filename: z
        .string()
        .describe("Display filename (defaults to basename of path)")
        .optional(),
    }),
    responseBody: z.object({
      id: z.string(),
      originalFilename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number(),
      kind: z.string(),
      filePath: z.string(),
      createdAt: z.number(),
    }),
    handler: handleAttachmentRegister,
  },
  {
    operationId: "attachment_lookup",
    endpoint: "attachments/lookup",
    method: "POST",
    summary: "Look up attachment by source path",
    description:
      "Search for a previously registered attachment by its original source path, scoped to a conversation.",
    tags: ["attachments"],
    requestBody: z.object({
      sourcePath: z.string().describe("Original source path of the file"),
      conversationId: z.string().describe("Conversation ID to search within"),
    }),
    responseBody: z.object({
      filePath: z.string(),
    }),
    handler: handleAttachmentLookup,
  },
];

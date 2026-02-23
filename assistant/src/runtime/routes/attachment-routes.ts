/**
 * Route handlers for attachment upload, download, and deletion.
 */
import { existsSync, statSync } from 'node:fs';
import * as attachmentsStore from '../../memory/attachments-store.js';
import { validateAttachmentUpload, AttachmentUploadError } from '../../memory/attachments-store.js';

/** 30 MB — base64-encoded 20 MB attachment ≈ 27 MB plus JSON wrapper overhead. */
const MAX_UPLOAD_BODY_BYTES = 30 * 1024 * 1024;

export async function handleUploadAttachment(req: Request): Promise<Response> {
  const rawBody = await req.arrayBuffer();
  if (rawBody.byteLength > MAX_UPLOAD_BODY_BYTES) {
    return Response.json(
      { error: `Request body too large (limit: ${MAX_UPLOAD_BODY_BYTES} bytes)` },
      { status: 413 },
    );
  }

  const body = JSON.parse(new TextDecoder().decode(rawBody)) as {
    filename?: string;
    mimeType?: string;
    data?: string;
  };

  const { filename, mimeType, data } = body;

  if (!filename || typeof filename !== 'string') {
    return Response.json(
      { error: 'filename is required' },
      { status: 400 },
    );
  }

  if (!mimeType || typeof mimeType !== 'string') {
    return Response.json(
      { error: 'mimeType is required' },
      { status: 400 },
    );
  }

  if (!data || typeof data !== 'string') {
    return Response.json(
      { error: 'data (base64) is required' },
      { status: 400 },
    );
  }

  const validation = validateAttachmentUpload(filename, mimeType);
  if (!validation.ok) {
    return Response.json(
      { error: validation.error },
      { status: 415 },
    );
  }

  let attachment: attachmentsStore.StoredAttachment;
  try {
    attachment = attachmentsStore.uploadAttachment(
      filename,
      mimeType,
      data,
    );
  } catch (err) {
    if (err instanceof AttachmentUploadError) {
      const status = err.message.startsWith('Attachment too large') ? 413 : 400;
      return Response.json({ error: err.message }, { status });
    }
    throw err;
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
    body = await req.json() as { attachmentId?: string };
  } catch {
    return Response.json(
      { error: 'Invalid or missing JSON body' },
      { status: 400 },
    );
  }

  const { attachmentId } = body;

  if (!attachmentId || typeof attachmentId !== 'string') {
    return Response.json(
      { error: 'attachmentId is required' },
      { status: 400 },
    );
  }

  const result = attachmentsStore.deleteAttachment(attachmentId);

  if (result === 'not_found') {
    return Response.json(
      { error: 'Attachment not found' },
      { status: 404 },
    );
  }

  if (result === 'still_referenced') {
    return Response.json(
      { error: 'Attachment is still referenced by one or more messages' },
      { status: 409 },
    );
  }

  return new Response(null, { status: 204 });
}

export function handleGetAttachment(attachmentId: string): Response {
  const attachment = attachmentsStore.getAttachmentById(attachmentId);
  if (!attachment) {
    return Response.json({ error: 'Attachment not found' }, { status: 404 });
  }

  return Response.json({
    id: attachment.id,
    filename: attachment.originalFilename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    data: attachment.dataBase64,
  });
}

/**
 * Stream attachment content as binary. Supports Range requests for video seek.
 *
 * For file-backed attachments: reads from disk with optional partial content.
 * For inline_base64 attachments: decodes the base64 data and returns it.
 */
export function handleGetAttachmentContent(attachmentId: string, req: Request): Response {
  const attachment = attachmentsStore.getAttachmentById(attachmentId);
  if (!attachment) {
    return Response.json({ error: 'Attachment not found' }, { status: 404 });
  }

  if (attachment.storageKind === 'file') {
    return handleFileContent(attachment, req);
  }

  // inline_base64 fallback — decode and return full content
  const buffer = Buffer.from(attachment.dataBase64, 'base64');
  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': attachment.mimeType,
      'Content-Length': String(buffer.length),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': 'inline',
    },
  });
}

/**
 * Serve file-backed attachment content with Range header support.
 */
function handleFileContent(
  attachment: attachmentsStore.StoredAttachment & { dataBase64: string },
  req: Request,
): Response {
  const filePath = attachment.filePath;
  if (!filePath || !existsSync(filePath)) {
    return Response.json({ error: 'Attachment file not found on disk' }, { status: 404 });
  }

  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    return Response.json({ error: 'Failed to read attachment file' }, { status: 500 });
  }

  const rangeHeader = req.headers.get('range');
  if (!rangeHeader) {
    // Full file response
    const file = Bun.file(filePath);
    return new Response(file, {
      status: 200,
      headers: {
        'Content-Type': attachment.mimeType,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'inline',
      },
    });
  }

  // Parse Range header (only supports single byte ranges)
  const rangeMatch = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
  if (!rangeMatch) {
    return new Response('Invalid Range header', {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileSize}` },
    });
  }

  const start = parseInt(rangeMatch[1], 10);
  const end = rangeMatch[2] ? Math.min(parseInt(rangeMatch[2], 10), fileSize - 1) : fileSize - 1;

  if (start >= fileSize || start > end) {
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileSize}` },
    });
  }

  const contentLength = end - start + 1;
  const file = Bun.file(filePath);
  const slice = file.slice(start, end + 1);

  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': attachment.mimeType,
      'Content-Length': String(contentLength),
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': 'inline',
    },
  });
}

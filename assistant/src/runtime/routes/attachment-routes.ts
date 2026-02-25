/**
 * Route handlers for attachment upload, download, and deletion.
 */
import * as attachmentsStore from '../../memory/attachments-store.js';
import { validateAttachmentUpload, AttachmentUploadError } from '../../memory/attachments-store.js';

/**
 * Parse an RFC 7233 byte-range header into resolved start/end offsets.
 * Supports: bytes=start-end, bytes=start-, bytes=-suffix.
 * Returns null for invalid or unsatisfiable ranges.
 */
function parseRangeHeader(header: string, size: number): { start: number; end: number } | null {
  // bytes=-suffix (last N bytes)
  const suffixMatch = header.match(/^bytes=-(\d+)$/);
  if (suffixMatch) {
    const suffix = parseInt(suffixMatch[1], 10);
    if (suffix <= 0) return null;
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  // bytes=start-end or bytes=start-
  const rangeMatch = header.match(/^bytes=(\d+)-(\d*)$/);
  if (!rangeMatch) return null;

  const start = parseInt(rangeMatch[1], 10);
  const rawEnd = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1;

  if (start >= size || start > rawEnd) return null;

  const end = Math.min(rawEnd, size - 1);
  return { start, end };
}

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
 * Serve attachment content with Range header support for video seeking.
 * File-backed attachments are streamed directly from disk; base64 attachments
 * are decoded and served as binary.
 */
export function handleGetAttachmentContent(attachmentId: string, req: Request): Response {
  const attachment = attachmentsStore.getAttachmentById(attachmentId);
  if (!attachment) {
    return Response.json({ error: 'Attachment not found' }, { status: 404 });
  }

  const contentType = attachment.mimeType;

  // File-backed attachment: serve from disk with Range support
  if (attachment.filePath) {
    const file = Bun.file(attachment.filePath);
    const fileSize = file.size;

    if (fileSize === 0) {
      return Response.json({ error: 'Attachment file is empty or missing' }, { status: 404 });
    }

    const rangeHeader = req.headers.get('Range');
    if (!rangeHeader) {
      return new Response(file, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes',
        },
      });
    }

    const parsed = parseRangeHeader(rangeHeader, fileSize);
    if (!parsed) {
      return new Response('Invalid Range header', {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileSize}` },
      });
    }

    const { start, end } = parsed;
    const contentLength = end - start + 1;
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': String(contentLength),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  // Base64-backed attachment: decode and serve
  const buffer = Buffer.from(attachment.dataBase64, 'base64');
  const totalSize = buffer.length;

  const rangeHeader = req.headers.get('Range');
  if (!rangeHeader) {
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const parsed = parseRangeHeader(rangeHeader, totalSize);
  if (!parsed) {
    return new Response('Invalid Range header', {
      status: 416,
      headers: { 'Content-Range': `bytes */${totalSize}` },
    });
  }

  const { start, end } = parsed;
  const contentLength = end - start + 1;
  return new Response(buffer.subarray(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': String(contentLength),
      'Accept-Ranges': 'bytes',
    },
  });
}

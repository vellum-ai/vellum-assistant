/**
 * Route handlers for attachment upload, download, and deletion.
 */
import { existsSync } from 'node:fs';
import * as attachmentsStore from '../../memory/attachments-store.js';
import { AttachmentUploadError, getFilePathForAttachment, validateAttachmentUpload } from '../../memory/attachments-store.js';

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

  const isFileBacked = !attachment.dataBase64;

  return Response.json({
    id: attachment.id,
    filename: attachment.originalFilename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    data: attachment.dataBase64,
    // Signal to clients that they should fetch content via the /content endpoint
    ...(isFileBacked ? { fileBacked: true } : {}),
  });
}

/**
 * Serve raw file bytes for an attachment. For file-backed attachments this
 * streams from disk; for inline attachments it decodes the base64 data.
 * Supports Range headers for video seeking.
 */
export function handleGetAttachmentContent(attachmentId: string, req: Request): Response {
  const attachment = attachmentsStore.getAttachmentById(attachmentId);
  if (!attachment) {
    return Response.json({ error: 'Attachment not found' }, { status: 404 });
  }

  // Check for file-backed attachment
  const filePath = getFilePathForAttachment(attachmentId);
  if (filePath) {
    if (!existsSync(filePath)) {
      return Response.json({ error: 'Recording file not found on disk' }, { status: 404 });
    }

    const file = Bun.file(filePath);
    const rangeHeader = req.headers.get('Range');

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
              'Content-Type': attachment.mimeType,
              'Content-Length': String(fileSize),
              'Accept-Ranges': 'bytes',
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
          headers: { 'Content-Range': `bytes */${fileSize}` },
        });
      }

      const slice = file.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          'Content-Type': attachment.mimeType,
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
        },
      });
    }

    return new Response(file, {
      headers: {
        'Content-Type': attachment.mimeType,
        'Content-Length': String(attachment.sizeBytes),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  // Fall back to base64-decoded content for inline attachments
  if (!attachment.dataBase64) {
    return Response.json({ error: 'No content available' }, { status: 404 });
  }

  const buffer = Buffer.from(attachment.dataBase64, 'base64');
  return new Response(buffer, {
    headers: {
      'Content-Type': attachment.mimeType,
      'Content-Length': String(buffer.length),
      'Accept-Ranges': 'bytes',
    },
  });
}

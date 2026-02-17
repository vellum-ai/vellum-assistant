/**
 * Route handlers for attachment upload, download, and deletion.
 */
import * as attachmentsStore from '../../memory/attachments-store.js';
import { validateAttachmentUpload, AttachmentUploadError } from '../../memory/attachments-store.js';

export async function handleUploadAttachment(assistantId: string, req: Request): Promise<Response> {
  const body = await req.json() as {
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
      assistantId,
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

export async function handleDeleteAttachment(assistantId: string, req: Request): Promise<Response> {
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

  const result = attachmentsStore.deleteAttachment(assistantId, attachmentId);

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

export function handleGetAttachment(assistantId: string, attachmentId: string): Response {
  const attachment = attachmentsStore.getAttachmentById(assistantId, attachmentId);
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

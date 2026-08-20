/**
 * Reads and finalizes downloaded attachment bytes for runtime upload.
 *
 * Attachment responses use the same streamed byte limit as webhook bodies.
 * Content-Length is only an early rejection because providers can omit or
 * misstate it, so the response stream remains the authoritative ceiling.
 */
import { fileTypeFromBuffer } from "file-type";

import {
  AttachmentTooLargeError,
  type DownloadedAttachment,
} from "./ingest.js";
import { validateDownloadedContent } from "../download-validation.js";
import { readLimitedBodyBytes } from "../http/read-limited-body.js";

export async function readLimitedAttachmentResponse(
  response: Response,
  maxBytes: number,
  attachmentId: string,
): Promise<ArrayBuffer> {
  const result = await readLimitedBodyBytes(response, maxBytes);
  if (result.status === "too_large") {
    throw new AttachmentTooLargeError(
      `Attachment ${attachmentId} exceeds the ${maxBytes}-byte limit`,
    );
  }
  if (result.status === "unreadable") {
    throw new Error(`Failed to read attachment ${attachmentId}`);
  }
  return result.bytes.buffer;
}

type DownloadFinalizationOptions = {
  attachmentId: string;
  mimeTypeCandidatesBeforeDetection: readonly (string | undefined)[];
  mimeTypeCandidatesAfterDetection?: readonly (string | undefined)[];
  responseContentType?: string | null;
  filename?: string;
  fallbackFilename: (mimeType: string) => string;
};

function responseMimeType(
  contentType: string | null | undefined,
): string | undefined {
  const mimeType = contentType?.split(";")[0].trim();
  return mimeType || undefined;
}

export async function finalizeDownloadedAttachment(
  buffer: ArrayBuffer,
  options: DownloadFinalizationOptions,
): Promise<DownloadedAttachment> {
  const bytes = new Uint8Array(buffer);
  const detected = await fileTypeFromBuffer(bytes);
  const mimeType =
    options.mimeTypeCandidatesBeforeDetection.find((candidate) => candidate) ||
    detected?.mime ||
    options.mimeTypeCandidatesAfterDetection?.find((candidate) => candidate) ||
    responseMimeType(options.responseContentType) ||
    "application/octet-stream";

  await validateDownloadedContent(bytes, mimeType, options.attachmentId);

  const filename = options.filename || options.fallbackFilename(mimeType);

  return {
    filename,
    mimeType,
    data: Buffer.from(buffer).toString("base64"),
  };
}

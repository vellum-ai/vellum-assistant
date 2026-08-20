/**
 * Finalizes downloaded attachment bytes for runtime upload.
 */
import { fileTypeFromBuffer } from "file-type";

import type { DownloadedAttachment } from "./ingest.js";
import { validateDownloadedContent } from "../download-validation.js";

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

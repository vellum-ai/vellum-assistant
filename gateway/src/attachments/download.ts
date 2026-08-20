/**
 * Finalizes downloaded attachment bytes for runtime upload.
 */
import { fileTypeFromBuffer } from "file-type";

import type { DownloadedAttachment } from "./ingest.js";
import { validateDownloadedContent } from "../download-validation.js";

type DownloadFinalizationOptions = {
  attachmentId: string;
  mimeTypeCandidates: readonly (string | undefined)[];
  responseContentType?: string | null;
  filename?: string;
  fallbackFilename: string | ((mimeType: string) => string);
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
    options.mimeTypeCandidates.find((candidate) => candidate) ||
    detected?.mime ||
    responseMimeType(options.responseContentType) ||
    "application/octet-stream";

  await validateDownloadedContent(bytes, mimeType, options.attachmentId);

  const filename =
    options.filename ||
    (typeof options.fallbackFilename === "function"
      ? options.fallbackFilename(mimeType)
      : options.fallbackFilename);

  return {
    filename,
    mimeType,
    data: Buffer.from(buffer).toString("base64"),
  };
}

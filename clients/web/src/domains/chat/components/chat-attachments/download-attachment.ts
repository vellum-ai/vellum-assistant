import {
  attachmentsByIdContentGet,
  attachmentsByIdGet,
} from "@/generated/daemon/sdk.gen";
import { publish } from "@/lib/event-bus";
import { captureError } from "@/lib/sentry/capture-error";
import { toApiError } from "@/utils/api-errors";
import type { AttachmentMetadata } from "@/types/attachment-types";

/**
 * Every reader of the attachment bytes lands here, so this is the one place
 * an attachment fetch failure is reported.
 */
function reportAttachmentFetchFailure(error: unknown): void {
  captureError(error, {
    context: "fetchAttachmentContentBlob",
    bestEffort: true,
  });
}

/**
 * Fetch an attachment's stored bytes from the daemon content endpoint.
 * Returns null when the id can never resolve (synthetic `rehydrated:` ids
 * from the text-parsing history fallback) or the fetch fails.
 */
export async function fetchAttachmentContentBlob(
  assistantId: string,
  attachmentId: string,
): Promise<Blob | null> {
  if (!attachmentId || attachmentId.startsWith("rehydrated:")) {
    return null;
  }

  try {
    const { data, error, response } = await attachmentsByIdContentGet({
      path: { assistant_id: assistantId, id: attachmentId },
      parseAs: "blob",
      throwOnError: false,
    });
    if (!error && data instanceof Blob) {
      return data;
    }
    // `throwOnError: false` hands HTTP failures back as a value, so the status
    // has to be attached here for the transient filter to read it.
    if (response && !response.ok) {
      // A deleted or unknown attachment is a state the surfaces render, not a
      // fault to report.
      if (response.status !== 404) {
        reportAttachmentFetchFailure(toApiError(error, response));
      }
    } else {
      reportAttachmentFetchFailure(
        error ?? new Error("Attachment content response carried no blob"),
      );
    }
    return null;
  } catch (err) {
    reportAttachmentFetchFailure(err);
    return null;
  }
}

/** Fetch canonical stored metadata for a referenced attachment. */
export async function fetchAttachmentMetadata(
  assistantId: string,
  attachmentId: string,
): Promise<AttachmentMetadata | null> {
  if (!attachmentId || attachmentId.startsWith("rehydrated:")) {
    return null;
  }
  try {
    const { data, error } = await attachmentsByIdGet({
      path: { assistant_id: assistantId, id: attachmentId },
      throwOnError: false,
    });
    if (error || !data) {
      return null;
    }
    return {
      id: data.id,
      filename: data.filename,
      mimeType: data.mimeType,
      sizeBytes: data.sizeBytes,
    };
  } catch {
    return null;
  }
}

/**
 * Download an attachment directly without opening the preview modal. Prefers
 * the daemon content endpoint because `previewUrl` may be a JPEG thumbnail
 * rather than the actual file (e.g. video attachments with `thumbnailData`
 * only). Referenced tool images also resolve their canonical stored filename
 * and MIME type because their message wire carries only an attachment id.
 * Falls back to `previewUrl` when the daemon endpoint is unavailable (no
 * assistantId, synthetic rehydrated IDs, or fetch failure).
 *
 * With neither source `saveFile` never runs, so this publishes the terminal
 * `download.done` itself. Nothing else would: a deleted attachment answers
 * 404, which the fetch reports as absence rather than a fault.
 */
export async function downloadAttachment(
  attachment: {
    id: string;
    filename: string;
    previewUrl: string | null;
    resolveReferenceMetadata?: boolean;
  },
  assistantId?: string | null,
): Promise<void> {
  const { saveFile } = await import("@/runtime/native-file");

  if (assistantId) {
    const [blob, metadata] = await Promise.all([
      fetchAttachmentContentBlob(assistantId, attachment.id),
      attachment.resolveReferenceMetadata
        ? fetchAttachmentMetadata(assistantId, attachment.id)
        : Promise.resolve(null),
    ]);
    if (blob) {
      const source =
        metadata?.mimeType && blob.type !== metadata.mimeType
          ? new Blob([blob], { type: metadata.mimeType })
          : blob;
      await saveFile(source, metadata?.filename ?? attachment.filename);
      return;
    }
  }

  if (attachment.previewUrl) {
    await saveFile(attachment.previewUrl, attachment.filename);
    return;
  }

  publish("download.done", {
    filename: attachment.filename,
    state: "interrupted",
  });
}

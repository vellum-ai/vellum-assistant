import { attachmentsByIdContentGet } from "@/generated/daemon/sdk.gen";

interface FetchAttachmentContentOptions {
  representation?: "original" | "display";
  signal?: AbortSignal;
}

/**
 * Fetch an attachment's stored bytes from the daemon content endpoint.
 * Returns null when the id can never resolve (synthetic `rehydrated:` ids
 * from the text-parsing history fallback) or the fetch fails. Aborted requests
 * reject so TanStack Query can classify cancellation correctly.
 */
export async function fetchAttachmentContentBlob(
  assistantId: string,
  attachmentId: string,
  options: FetchAttachmentContentOptions = {},
): Promise<Blob | null> {
  if (!attachmentId || attachmentId.startsWith("rehydrated:")) {
    return null;
  }

  try {
    const { data, error } = await attachmentsByIdContentGet({
      path: { assistant_id: assistantId, id: attachmentId },
      query: options.representation
        ? { representation: options.representation }
        : undefined,
      parseAs: "blob",
      signal: options.signal,
      throwOnError: false,
    });
    if (!error && data instanceof Blob) {
      return data;
    }
    return null;
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    // Network failure, assistant offline, etc.
    return null;
  }
}

/**
 * Download an attachment directly without opening the preview modal. Prefers
 * the daemon content endpoint because `previewUrl` may be a JPEG thumbnail
 * rather than the actual file (e.g. video attachments with `thumbnailData`
 * only). Falls back to `previewUrl` when the daemon endpoint is unavailable
 * (no assistantId, synthetic rehydrated IDs, or fetch failure).
 */
export async function downloadAttachment(
  attachment: {
    id: string;
    filename: string;
    previewUrl: string | null;
  },
  assistantId?: string | null,
): Promise<void> {
  const { saveFile } = await import("@/runtime/native-file");

  if (assistantId) {
    const blob = await fetchAttachmentContentBlob(assistantId, attachment.id);
    if (blob) {
      await saveFile(blob, attachment.filename);
      return;
    }
  }

  if (attachment.previewUrl) {
    await saveFile(attachment.previewUrl, attachment.filename);
  }
}

import { attachmentsByIdContentGet } from "@/generated/daemon/sdk.gen";

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

  if (assistantId && attachment.id && !attachment.id.startsWith("rehydrated:")) {
    try {
      const { data, error } = await attachmentsByIdContentGet({
        path: { assistant_id: assistantId, id: attachment.id },
        parseAs: "blob",
        throwOnError: false,
      });

      if (!error && data instanceof Blob) {
        await saveFile(data, attachment.filename);
        return;
      }
    } catch {
      // Network failure, assistant offline, etc. — fall through to previewUrl.
    }
  }

  if (attachment.previewUrl) {
    await saveFile(attachment.previewUrl, attachment.filename);
  }
}

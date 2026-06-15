import { attachmentsByIdContentGet } from "@/generated/daemon/sdk.gen";

/**
 * Download an attachment directly without opening the preview modal. When a
 * `previewUrl` is available it is passed straight to the cross-platform
 * `saveFile` helper; otherwise the content is fetched on-demand from the
 * daemon API and handed to `saveFile` as a Blob.
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

  if (attachment.previewUrl) {
    await saveFile(attachment.previewUrl, attachment.filename);
    return;
  }

  if (!assistantId || !attachment.id || attachment.id.startsWith("rehydrated:")) {
    return;
  }

  const { data, error } = await attachmentsByIdContentGet({
    path: { assistant_id: assistantId, id: attachment.id },
    parseAs: "blob",
    throwOnError: false,
  });

  if (error || !(data instanceof Blob)) {
    return;
  }

  await saveFile(data, attachment.filename);
}

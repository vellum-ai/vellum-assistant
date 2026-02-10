import { getDb } from "@/lib/db";
import { getStorage } from "@/lib/storage";

const ATTACHMENTS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || "vellum-ai-prod-vellum-assistant";

interface AttachmentStorageKeyRow {
  storage_key: string | null;
}

export async function deleteAssistantAttachmentObjects(assistantId: string): Promise<void> {
  const sql = getDb();
  const rows = await sql<AttachmentStorageKeyRow[]>`
    SELECT storage_key
    FROM chat_attachments
    WHERE assistant_id = ${assistantId}
  `;

  const storageKeys = rows
    .map((row) => row.storage_key)
    .filter((storageKey): storageKey is string => typeof storageKey === "string" && storageKey.length > 0);

  if (storageKeys.length === 0) {
    return;
  }

  const bucket = getStorage().bucket(ATTACHMENTS_BUCKET_NAME);
  const deletionResults = await Promise.allSettled(
    storageKeys.map((storageKey) => bucket.file(storageKey).delete()),
  );

  const failedKeys = deletionResults
    .map((result, index) => ({ result, storageKey: storageKeys[index] }))
    .filter((entry) => entry.result.status === "rejected")
    .map((entry) => entry.storageKey);

  if (failedKeys.length > 0) {
    const preview = failedKeys.slice(0, 3).join(", ");
    const suffix = failedKeys.length > 3 ? ", ..." : "";
    throw new Error(
      `Failed to delete ${failedKeys.length} attachment object(s): ${preview}${suffix}`,
    );
  }
}

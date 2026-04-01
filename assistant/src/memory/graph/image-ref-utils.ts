import { eq } from "drizzle-orm";

import { getDb } from "../db.js";
import { extractMediaBlocks } from "../message-content.js";
import { messages } from "../schema.js";
import type { ImageRef } from "./types.js";

/**
 * Load image data from the messages table for an ImageRef.
 * Returns null if the message or image block no longer exists
 * (e.g., conversation was deleted).
 */
export async function loadImageRefData(
  ref: ImageRef,
): Promise<{ data: Buffer; mimeType: string } | null> {
  const db = getDb();
  const msg = db
    .select({ content: messages.content })
    .from(messages)
    .where(eq(messages.id, ref.messageId))
    .get();
  if (!msg) return null;

  const mediaBlocks = extractMediaBlocks(msg.content);
  const block = mediaBlocks.find((b) => b.index === ref.blockIndex);
  if (!block) return null;

  return { data: block.data, mimeType: block.mimeType };
}

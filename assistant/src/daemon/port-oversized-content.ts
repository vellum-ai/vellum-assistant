/**
 * Move a user text payload that exceeds the provider string cap into the
 * conversation attachment store, and leave a short note plus a workspace_ref
 * in the message. The full text stays on disk, off the model prompt.
 */

import { createInlineAttachment } from "../persistence/attachments-store.js";
import {
  MAX_PROVIDER_STRING_BYTES,
  utf8ByteLength,
} from "../providers/content-block-size.js";
import type { ContentBlock } from "../providers/types.js";

export const OVERSIZED_CONTENT_FILENAME = "oversized-content.txt";

export const OVERSIZED_CONTENT_NOTE =
  "Content exceeded the provider size limit and was saved as a workspace file.";

export interface PortOversizedContext {
  conversationId: string;
  conversationCreatedAt: number;
}

export interface OffloadOversizedTextResult {
  text: string;
  fileBlock?: Extract<ContentBlock, { type: "file" }>;
  attachmentId?: string;
}

export async function offloadOversizedText(
  text: string,
  ctx: PortOversizedContext,
  maxBytes: number = MAX_PROVIDER_STRING_BYTES,
): Promise<OffloadOversizedTextResult> {
  if (utf8ByteLength(text) <= maxBytes) {
    return { text };
  }

  const stored = await createInlineAttachment(
    ctx.conversationId,
    ctx.conversationCreatedAt,
    OVERSIZED_CONTENT_FILENAME,
    "text/plain",
    Buffer.from(text, "utf8").toString("base64"),
    { skipSizeLimit: true },
  );

  return {
    text: OVERSIZED_CONTENT_NOTE,
    fileBlock: {
      type: "file",
      source: {
        type: "workspace_ref",
        media_type: "text/plain",
        attachmentId: stored.id,
        sizeBytes: stored.sizeBytes,
        filename: OVERSIZED_CONTENT_FILENAME,
      },
    },
    attachmentId: stored.id,
  };
}

/**
 * Persist may offload a display-only copy (raw Slack, etc.) that must stay
 * linked for GC but must not be named on the model-facing attachment list.
 * The live offload is the only one `enrichMessageWithSourcePaths` may see.
 */
export function offloadLinkPlan(
  persistAttachmentId: string | undefined,
  liveAttachmentId: string | undefined,
): { linkIds: string[]; modelFacingIds: ReadonlySet<string> } {
  const linkIds = [
    ...new Set(
      [persistAttachmentId, liveAttachmentId].filter(
        (id): id is string => id !== undefined,
      ),
    ),
  ];
  return {
    linkIds,
    modelFacingIds: new Set(liveAttachmentId ? [liveAttachmentId] : []),
  };
}

export function assembleUserContentBlocks(
  text: string,
  attachmentBlocks: ContentBlock[],
  extraFileBlock?: ContentBlock,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (text.trim().length > 0) {
    blocks.push({ type: "text", text });
  }
  blocks.push(...attachmentBlocks);
  if (extraFileBlock) {
    blocks.push(extraFileBlock);
  }
  return blocks;
}

import type { ContentBlock, Message } from "../providers/types.js";
import { optimizeImageForTransport } from "./image-optimize.js";

export interface MessageAttachmentInput {
  id?: string;
  filename: string;
  mimeType: string;
  data: string;
  extractedText?: string;
  filePath?: string;
}

export function attachmentsToContentBlocks(
  attachments: MessageAttachmentInput[],
): ContentBlock[] {
  return attachments.map((attachment) => {
    if (attachment.mimeType.toLowerCase().startsWith("image/")) {
      const { data, mediaType } = optimizeImageForTransport(
        attachment.data,
        attachment.mimeType,
      );
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data,
        },
        ...(attachment.id ? { _attachmentId: attachment.id } : {}),
      } as ContentBlock;
    }

    return {
      type: "file",
      source: {
        type: "base64",
        media_type: attachment.mimeType,
        data: attachment.data,
        filename: attachment.filename,
      },
      extracted_text: attachment.extractedText,
      ...(attachment.id ? { _attachmentId: attachment.id } : {}),
    } as ContentBlock;
  });
}

/**
 * Tag the `mediaBlockIndex`-th image/file content block of a message with
 * `attachmentId`, mutating it in place. Returns silently if the target block is
 * missing or already carries an id (never overwrites an existing id).
 *
 * This is the single shared place where an attachment id is mapped to a media
 * block by ordinal position. Both the live backfill path
 * ({@link backfillAttachmentId}) and the reload rehydration path
 * ({@link rehydrateAttachmentIds}) route through it so the two can never drift
 * in how they index media blocks.
 *
 * Attachment blocks are appended to `message.content` in attachment order by
 * {@link attachmentsToContentBlocks}, after any leading text block and before
 * any trailing source-path annotation, so the n-th `image`/`file` block always
 * corresponds to the n-th uploaded attachment (i.e. its `message_attachments`
 * `position`).
 */
function tagMediaBlockAtIndex(
  message: Message,
  mediaBlockIndex: number,
  attachmentId: string,
): void {
  if (mediaBlockIndex < 0) return;
  let seen = 0;
  for (const block of message.content) {
    if (block.type !== "image" && block.type !== "file") continue;
    if (seen === mediaBlockIndex) {
      if (!block._attachmentId) block._attachmentId = attachmentId;
      return;
    }
    seen++;
  }
}

/**
 * Backfill an attachment id onto the in-memory content block for the
 * `attachmentIndex`-th uploaded attachment.
 *
 * Inline (data-only) uploads have no attachment id when the message body is
 * built — the id is minted later, when the attachment row is created and linked
 * to the persisted message. Without this backfill the image/file block sent to
 * the model never carries `_attachmentId`, so downstream consumers (notably the
 * vision-perception media markers) cannot correlate the block back to a usable
 * `media_ref`.
 *
 * The live persist loop iterates the uploaded-attachment array by index and
 * passes that same index here as `attachmentIndex` — which is also the value it
 * writes to `message_attachments.position`. So `attachmentIndex` is exactly the
 * media-block ordinal to tag. Mutates the block in place (the caller holds the
 * same reference the model loop reads). A no-op if the target block is missing
 * or already carries an id.
 */
export function backfillAttachmentId(
  message: Message,
  attachmentIndex: number,
  attachmentId: string,
): void {
  tagMediaBlockAtIndex(message, attachmentIndex, attachmentId);
}

/** A linked attachment paired with its stored `message_attachments.position`. */
export interface PositionedAttachmentId {
  /** The `message_attachments.position` — the media-block ordinal to tag. */
  position: number;
  attachmentId: string;
}

/**
 * Rehydrate `_attachmentId` onto a message's image/file content blocks from the
 * message's linked attachments, placing each id at the media-block ordinal that
 * matches its stored `message_attachments.position`.
 *
 * The persisted message JSON never carries `_attachmentId` — it is minted only
 * after the message row exists and is then backfilled onto the *in-memory*
 * block (see {@link backfillAttachmentId}), so a conversation reloaded from the
 * DB (eviction, restart, fork) loses it. This reapplies each id at load time at
 * the exact same media-block index the live path used.
 *
 * Critically, this is POSITION-AWARE rather than sequential: at upload time an
 * attachment can be skipped (unsupported/dangerous MIME, or no data) while its
 * media block still persists in the message JSON and the live path still
 * advances the index. So `message_attachments` is sparse — its `position`
 * values may have gaps. Placing ids by `position` (via the same
 * {@link tagMediaBlockAtIndex} the live {@link backfillAttachmentId} uses)
 * keeps the skipped block untagged and assigns each stored id to the block it
 * actually belongs to, so `media_ref` markers point at the right upload.
 *
 * Mutates blocks in place. Blocks already carrying an id are left untouched, and
 * positions with no matching media block (e.g. tool-generated media with no
 * persisted block) are ignored.
 */
export function rehydrateAttachmentIds(
  message: Message,
  positionedAttachmentIds: readonly PositionedAttachmentId[],
): void {
  for (const { position, attachmentId } of positionedAttachmentIds) {
    tagMediaBlockAtIndex(message, position, attachmentId);
  }
}

/**
 * Return a copy of the message with text annotations for image source paths.
 * The annotations are appended as a text content block so the LLM knows where
 * the images came from on disk. The caller should persist the ORIGINAL message
 * (without annotations) so the UI stays clean.
 */
export function enrichMessageWithSourcePaths(
  message: Message,
  attachments: MessageAttachmentInput[],
): Message {
  const imageAttachments = attachments.filter(
    (a) => a.mimeType.toLowerCase().startsWith("image/") && a.filePath,
  );
  if (imageAttachments.length === 0) return message;

  const annotation = imageAttachments
    .map((a) => `[Attached image source: ${a.filePath}]`)
    .join("\n");

  return {
    ...message,
    content: [...message.content, { type: "text" as const, text: annotation }],
  };
}

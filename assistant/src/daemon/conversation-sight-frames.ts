/**
 * Retention for ambient camera frames, the images a call samples on its own
 * while the camera is up.
 *
 * A frame arrives about once per spoken turn and history resends every inline
 * image on every later request, so a long call grows its own context until the
 * provider rejects it. {@link stripAgedSightFrames} keeps only the newest few
 * frames as real images and replaces the rest with text stubs, on the copy of
 * the history a turn is about to send.
 *
 * This is the proactive counterpart to `stripMediaPayloadsForRetry`
 * (`conversation-media-retry.ts`), which fires only after a provider has
 * already rejected a request and which governs every kind of media. The two
 * live apart because that module reaches the compaction layer for its
 * summary-message predicate and this one must stay a leaf the assembly path can
 * import. They agree on the shape of what they leave behind: a `text` block
 * naming the media that was dropped, so a frame stubbed here is plain text by
 * the time the retry path walks the history and is neither counted as media nor
 * stubbed a second time. Keep the stub wording below in step with
 * `imageBlockToStub` there.
 */

import { mediaSourceByteLength } from "../providers/media-resolve.js";
import type { ContentBlock, Message } from "../providers/types.js";

/**
 * How many camera frames stay in the context as real images, counted
 * newest-first across the whole conversation so the frames on the most recent
 * turns are the ones that survive.
 *
 * Smaller than `RETRY_KEEP_LATEST_MEDIA_BLOCKS` (3, in
 * `conversation-media-retry.ts`) because the two budgets answer different
 * questions. That one is reactive and spends a rejected request's remaining
 * room across every kind of media, including files the user deliberately sent.
 * This one is proactive, applied to every assembly, and governs only frames the
 * camera sampled by itself: background the model glances at, not something
 * anyone chose to attach.
 */
export const KEEP_LATEST_SIGHT_FRAMES = 2;

/**
 * The attachment row an image block came from, or null when it came from none.
 *
 * Two shapes carry the same fact, because a turn sends its uploads inline while
 * persisting them as references: a reloaded block names the row on
 * `source.attachmentId`, and the live in-memory block a turn pushed names it on
 * `_attachmentId` (see `attachmentsToContentBlocks`). Matching on both is what
 * lets one uninterrupted call and a reloaded conversation share a single pool
 * of frames.
 *
 * Tool-generated and assistant-authored images carry neither and resolve to
 * null, so they can never be mistaken for a tagged frame.
 */
export function imageAttachmentId(
  block: Extract<ContentBlock, { type: "image" }>,
): string | null {
  if (block.source.type === "workspace_ref") {
    return block.source.attachmentId;
  }
  return block._attachmentId ?? null;
}

/**
 * True when any image in the history can be traced back to an attachment row.
 *
 * The retention pass reads rows to learn which attachments were camera frames;
 * a history holding no attributable image has nothing those rows could match,
 * so callers use this to skip the read entirely. Shares
 * {@link imageAttachmentId} with the matcher so the two cannot disagree about
 * what is skippable.
 */
export function hasAttributableImages(messages: Message[]): boolean {
  return messages.some((message) =>
    message.content.some(
      (block) => block.type === "image" && imageAttachmentId(block) !== null,
    ),
  );
}

/**
 * Replace every camera frame in `messages` except the newest
 * {@link KEEP_LATEST_SIGHT_FRAMES} with a text stub.
 *
 * `frameCaptureTimes` maps an attachment id the conversation tagged as a camera
 * frame to when the row carrying it was written; an image block counts as a
 * frame only when {@link imageAttachmentId} resolves it to one of those ids.
 * Every other attachment (picked files, pasted images, shutter photos) is left
 * alone here.
 *
 * Frames are ranked by their position in the history rather than by capture
 * time, so a row backdated by `sentAt` cannot displace a frame the model saw
 * more recently. Returns the input array itself when nothing is replaced.
 */
export function stripAgedSightFrames(
  messages: Message[],
  frameCaptureTimes: ReadonlyMap<string, number>,
): { messages: Message[]; modified: boolean; replacedBlocks: number } {
  if (frameCaptureTimes.size === 0) {
    return { messages, modified: false, replacedBlocks: 0 };
  }

  const frames: Array<{
    messageIndex: number;
    blockIndex: number;
    capturedAt: number;
  }> = [];
  for (const [messageIndex, message] of messages.entries()) {
    for (const [blockIndex, block] of message.content.entries()) {
      if (block.type !== "image") {
        continue;
      }
      const attachmentId = imageAttachmentId(block);
      if (attachmentId === null) {
        continue;
      }
      const capturedAt = frameCaptureTimes.get(attachmentId);
      if (capturedAt === undefined) {
        continue;
      }
      frames.push({ messageIndex, blockIndex, capturedAt });
    }
  }
  if (frames.length <= KEEP_LATEST_SIGHT_FRAMES) {
    return { messages, modified: false, replacedBlocks: 0 };
  }

  // History runs oldest to newest, so dropping the tail keeps the newest.
  const aged = new Map<number, Map<number, number>>();
  for (const frame of frames.slice(
    0,
    frames.length - KEEP_LATEST_SIGHT_FRAMES,
  )) {
    const blocks = aged.get(frame.messageIndex) ?? new Map<number, number>();
    blocks.set(frame.blockIndex, frame.capturedAt);
    aged.set(frame.messageIndex, blocks);
  }

  let replacedBlocks = 0;
  const nextMessages = messages.map((message, messageIndex) => {
    const blocks = aged.get(messageIndex);
    if (!blocks) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((block, blockIndex) => {
        const capturedAt = blocks.get(blockIndex);
        if (capturedAt === undefined || block.type !== "image") {
          return block;
        }
        replacedBlocks += 1;
        return sightFrameBlockToStub(block, capturedAt);
      }),
    };
  });

  return { messages: nextMessages, modified: true, replacedBlocks };
}

/**
 * Stub for a frame that has aged out of the context. Mirrors the media type and
 * byte size the retry path's image stub reports, and adds the capture time,
 * which is the only thing telling one ambient frame from another once the
 * pixels are gone. A frame is always an image, so the extracted-text folding
 * the retry path does for file blocks has nothing to act on here.
 */
function sightFrameBlockToStub(
  block: Extract<ContentBlock, { type: "image" }>,
  capturedAt: number,
): Extract<ContentBlock, { type: "text" }> {
  const sizeBytes = mediaSourceByteLength(block.source);
  const capturedAtIso = new Date(capturedAt).toISOString();
  return {
    type: "text",
    text: `[Camera frame omitted from context: captured ${capturedAtIso}, ${block.source.media_type}, ${sizeBytes} bytes]`,
  };
}

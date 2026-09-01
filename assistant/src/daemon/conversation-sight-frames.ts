/**
 * Retention for ambient camera frames, the images a call samples on its own
 * while the camera is up.
 *
 * Frames arrive every few seconds for as long as the camera is up, and history
 * resends every inline image on every later request, so a long call grows its
 * own context until the provider rejects it. {@link stripAgedSightFrames} keeps
 * only the newest `sight.keepLatestFrames` as real images and replaces the rest
 * with text stubs, on the copy of the history a turn is about to send.
 *
 * This is the proactive counterpart to `stripMediaPayloadsForRetry`
 * (`conversation-media-retry.ts`), which fires only after a provider has
 * already rejected a request and which governs every kind of media. The two
 * live apart because that module reaches the compaction layer for its
 * summary-message predicate and this one must stay a leaf the assembly path can
 * import. They agree on the shape of what they leave behind: a `text` block
 * naming the media that was dropped, so a frame stubbed here is plain text by
 * the time the retry path walks the history and is neither counted as media nor
 * stubbed a second time. Both describe that media through
 * `mediaSourceDescriptor`, which is what holds the two wordings together
 * without either module importing the other.
 */

import { getConfig } from "../config/loader.js";
import {
  KEEP_LATEST_SIGHT_FRAMES,
  MAX_SIGHT_KEEP_LATEST_FRAMES,
  MIN_SIGHT_KEEP_LATEST_FRAMES,
} from "../config/schemas/sight.js";
import { mediaSourceDescriptor } from "../providers/media-resolve.js";
import {
  type ContentBlock,
  mediaBlockAttachmentId,
  type Message,
} from "../providers/types.js";

/**
 * The workspace's `sight.keepLatestFrames`, clamped to
 * [{@link MIN_SIGHT_KEEP_LATEST_FRAMES}, {@link MAX_SIGHT_KEEP_LATEST_FRAMES}].
 *
 * Clamped at read rather than rejected by the schema because an out-of-range
 * value states an intent the guardrail can honor part of the way: capping it
 * shows the most frames the budget allows, while failing validation would fall
 * back to the default and show a number neither the config nor the guardrail
 * asked for.
 */
export function resolveSightKeepLatestFrames(): number {
  const configured = getConfig().sight.keepLatestFrames;
  if (!Number.isFinite(configured)) {
    return KEEP_LATEST_SIGHT_FRAMES;
  }
  return Math.min(
    MAX_SIGHT_KEEP_LATEST_FRAMES,
    Math.max(MIN_SIGHT_KEEP_LATEST_FRAMES, Math.trunc(configured)),
  );
}

/**
 * True when any image in the history can be traced back to an attachment row.
 *
 * The retention pass reads rows to learn which attachments were camera frames;
 * a history holding no attributable image has nothing those rows could match,
 * so callers use this to skip the read entirely. Shares
 * {@link mediaBlockAttachmentId} with the matcher so the two cannot disagree
 * about what is skippable.
 */
export function hasAttributableImages(messages: Message[]): boolean {
  return messages.some((message) =>
    message.content.some(
      (block) =>
        block.type === "image" && mediaBlockAttachmentId(block) !== undefined,
    ),
  );
}

/**
 * Replace every camera frame in `messages` except the newest
 * `keepLatestFrames` with a text stub.
 *
 * `keepLatestFrames` defaults to {@link KEEP_LATEST_SIGHT_FRAMES}, the config
 * default. The assembly path passes {@link resolveSightKeepLatestFrames}
 * instead, so what a turn sends follows the workspace's own setting.
 *
 * `frameCaptureTimes` maps an attachment id the conversation tagged as a camera
 * frame to when the row carrying it was written; an image block counts as a
 * frame only when {@link mediaBlockAttachmentId} resolves it to one of those
 * ids. Every other attachment (picked files, pasted images, shutter photos) is
 * left alone here.
 *
 * Frames are ranked by capture time, not by where they sit in the history:
 * compaction rebuilds the frames it keeps into one synthetic message in the
 * order the model listed them, so position stops tracking recency the moment a
 * conversation has been compacted. The times come from the rows themselves
 * (`createdAt`, which `monotonicNow` keeps strictly increasing), so they order
 * frames the way they were captured and no client-supplied timestamp can perturb
 * that. Frames sharing a row share a time and fall back to history order, which
 * is the order they were attached. Returns the input array itself when nothing
 * is replaced.
 */
export function stripAgedSightFrames(
  messages: Message[],
  frameCaptureTimes: ReadonlyMap<string, number>,
  keepLatestFrames: number = KEEP_LATEST_SIGHT_FRAMES,
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
      const attachmentId = mediaBlockAttachmentId(block);
      if (attachmentId === undefined) {
        continue;
      }
      const capturedAt = frameCaptureTimes.get(attachmentId);
      if (capturedAt === undefined) {
        continue;
      }
      frames.push({ messageIndex, blockIndex, capturedAt });
    }
  }
  if (frames.length <= keepLatestFrames) {
    return { messages, modified: false, replacedBlocks: 0 };
  }

  // Oldest first by capture time, so dropping the tail keeps the newest. The
  // sort is stable and `frames` was collected in history order, which is what
  // separates frames that share a row's timestamp.
  const byCaptureTime = [...frames].sort((a, b) => a.capturedAt - b.capturedAt);
  const aged = new Map<number, Map<number, number>>();
  for (const frame of byCaptureTime.slice(
    0,
    byCaptureTime.length - keepLatestFrames,
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
 * Stub for a frame that has aged out of the context. Describes the dropped
 * media through `mediaSourceDescriptor`, the same way the retry path's stubs
 * do, and adds the capture time, which is the only thing telling one ambient
 * frame from another once the pixels are gone. A frame is always an image, so
 * the extracted-text folding the retry path does for file blocks has nothing to
 * act on here.
 */
function sightFrameBlockToStub(
  block: Extract<ContentBlock, { type: "image" }>,
  capturedAt: number,
): Extract<ContentBlock, { type: "text" }> {
  const capturedAtIso = new Date(capturedAt).toISOString();
  return {
    type: "text",
    text: `[Camera frame omitted from context: captured ${capturedAtIso}, ${mediaSourceDescriptor(block.source)}]`,
  };
}

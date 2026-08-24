/**
 * Transcript notice for images a turn cannot show the model.
 *
 * Providers accept exactly four image formats (PNG, JPEG, GIF, WebP), so an
 * attachment whose bytes are anything else (a corrupt payload, or a HEIC/AVIF
 * file carrying a `.png` name) is dropped at the provider send boundary by
 * `resolveMediaReferences`. Dropping is what keeps the rest of the turn alive,
 * but on its own it is silent: the user sees their image in the transcript and
 * a reply that ignores it. The card names the files, so the removal is visible
 * and actionable (convert and re-attach) instead of a mystery.
 */

import { isUnsendableImageSource } from "../providers/media-resolve.js";
import type { MediaSource } from "../providers/types.js";
import { persistSystemCard } from "../runtime/routes/canned-message-complete.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("unsendable-image-notice");

/** An image attachment of a persisted message, as the card check sees it. */
export interface AttachedImage {
  filename: string;
  source: MediaSource;
}

/** The attachments the send boundary will drop, by filename. */
export function unsendableImageFilenames(images: AttachedImage[]): string[] {
  return images
    .filter((image) => isUnsendableImageSource(image.source))
    .map((image) => image.filename);
}

/** Transcript copy for the images this message cannot send to the model. */
export function unsendableImageCardText(filenames: string[]): string {
  const names = filenames.join(", ");
  return filenames.length === 1
    ? `${names} was not sent to the model: the file is not a PNG, JPEG, GIF, or WebP image. Convert it and attach it again to include it.`
    : `${names} were not sent to the model: the files are not PNG, JPEG, GIF, or WebP images. Convert them and attach them again to include them.`;
}

/**
 * Post a card naming the attachments of a just-persisted message that the send
 * boundary will drop, or do nothing when every attachment is readable.
 *
 * The card is non-terminal: it rides the messages-changed invalidation without
 * a `message_complete`, so posting it while the turn it describes is in flight
 * leaves that turn's streaming state untouched. Failures are logged and
 * swallowed: the turn is already usable without the notice, and losing the
 * user's whole message to a card write is a worse outcome than losing the card.
 */
export async function postUnsendableImageNotice(
  conversationId: string,
  images: AttachedImage[],
): Promise<void> {
  const filenames = unsendableImageFilenames(images);
  if (filenames.length === 0) {
    return;
  }
  log.warn(
    { conversationId, filenames },
    "User attachments are not a provider-readable image format; posting notice",
  );
  try {
    await persistSystemCard({
      conversationId,
      text: unsendableImageCardText(filenames),
      metadata: { unsendableImageFilenames: filenames },
      endsTurn: false,
    });
  } catch (err) {
    log.error(
      { conversationId, err },
      "Failed to post unsendable-image notice",
    );
  }
}

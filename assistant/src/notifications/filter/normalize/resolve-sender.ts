/**
 * Sender resolution is enrichment, not a precondition. A contact-store failure
 * must never fail normalization, so every lookup here degrades to null.
 */

import { findContactChannel } from "../../../contacts/contact-store.js";
import { getLogger } from "../../../util/logger.js";
import type { NotificationSender } from "./types.js";

const log = getLogger("notification-filter:resolve-sender");

export interface SenderLookup {
  address?: string;
  externalChatId?: string;
}

/**
 * Resolve a source-native sender identity to a local contact id.
 * `findContactChannel` owns address canonicalization; do not pre-normalize.
 */
export function resolveSenderContactId(
  channelType: string,
  params: SenderLookup,
): string | null {
  if (!params.address && !params.externalChatId) {
    return null;
  }
  try {
    const match = findContactChannel({ channelType, ...params });
    return match?.contact.id ?? null;
  } catch (err) {
    log.debug({ err, channelType }, "Contact lookup failed for sender");
    return null;
  }
}

/** Return `sender` with `contactId` filled in from the contact store. */
export function attachContactId(
  sender: Omit<NotificationSender, "contactId">,
  channelType: string,
  params: SenderLookup,
): NotificationSender {
  return {
    ...sender,
    contactId: resolveSenderContactId(channelType, params),
  };
}

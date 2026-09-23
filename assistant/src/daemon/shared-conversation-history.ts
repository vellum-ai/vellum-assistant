/**
 * History for a trusted contact's turn in a conversation shared with them.
 *
 * An untrusted actor's history is normally only the rows untrusted turns
 * wrote (`filterMessagesForUntrustedActor`). A participant in a shared
 * conversation already reads its whole transcript through the shared read
 * routes, so their turn is given that transcript, and only that:
 *
 * - A row the reader's own turn wrote loads as it is stored, exactly as it
 *   does in any untrusted actor's view. Every row of a turn (the message,
 *   the replies, the tool results) carries the turn's trust class, channel
 *   and requester identifier, which on `vellum-shared` is the contact's
 *   principal.
 * - Every other row, another contact's turns included, loads as its contact
 *   projection, the form the shared read routes show it in. Reasoning, tool
 *   calls and their results, and cards stay out, and the row's metadata is
 *   dropped, so nothing injected into the turn that wrote it (memory,
 *   workspace, turn context, NOW.md) is rehydrated. The projection also drops
 *   injected blocks still embedded in older user rows. A row whose turn
 *   cannot be attributed to the reader is projected.
 * - A row restricted to another reader is left out entirely.
 *
 * Only the conversation's own rows are read, and the compaction summary stays
 * suppressed as it is for every untrusted view, so nothing from the
 * guardian's other conversations or from assembly-time material reaches the
 * turn.
 */

import {
  type ContactReader,
  projectRowForContact,
  rowAudienceAdmits,
} from "../persistence/contact-visible-content.js";
import type { MessageRow } from "../persistence/conversation-crud.js";
import { isParticipant } from "../persistence/conversation-participants.js";
import type { ContentBlock } from "../providers/types.js";
import { isPlainObject } from "../util/object.js";
import type { TrustContext } from "./trust-context-types.js";

/**
 * The reader a turn's history is the shared transcript for, or null when the
 * turn gets the ordinary view for its trust class. Only a trusted contact's
 * turn on the `vellum-shared` channel qualifies, and only while that contact
 * is still an active participant, so a contact on any other channel, or one
 * removed from the conversation, keeps the narrower view.
 */
export function sharedTranscriptReader(
  conversationId: string,
  trustContext: TrustContext | undefined,
): ContactReader | null {
  if (
    trustContext?.sourceChannel !== "vellum-shared" ||
    trustContext.trustClass !== "trusted_contact"
  ) {
    return null;
  }
  const principalId = trustContext.requesterExternalUserId;
  if (!principalId || !isParticipant(conversationId, principalId)) {
    return null;
  }
  return { principalId };
}

/** Whether the reader's own turn on `vellum-shared` wrote the row. */
function isReadersOwnRow(
  metadata: string | null,
  reader: ContactReader,
): boolean {
  if (!metadata) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) {
    return false;
  }
  return (
    parsed.provenanceTrustClass === "trusted_contact" &&
    parsed.provenanceSourceChannel === "vellum-shared" &&
    parsed.provenanceRequesterIdentifier === reader.principalId
  );
}

/** The rows a shared-conversation participant's turn loads, in order. */
export function scopeRowsForSharedReader(
  rows: MessageRow[],
  reader: ContactReader,
): MessageRow[] {
  const scoped: MessageRow[] = [];
  for (const row of rows) {
    if (isReadersOwnRow(row.metadata, reader)) {
      if (rowAudienceAdmits(row.metadata, reader)) {
        scoped.push(row);
      }
      continue;
    }
    // The projection applies the audience itself.
    const content: ContentBlock[] = projectRowForContact(row, reader, {
      keepUntrustedFence: true,
    });
    if (content.length > 0) {
      scoped.push({ ...row, content, metadata: null });
    }
  }
  return scoped;
}

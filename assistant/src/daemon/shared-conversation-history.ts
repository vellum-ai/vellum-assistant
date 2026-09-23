/**
 * History for a trusted contact's turn in a conversation shared with them.
 *
 * An untrusted actor's history is normally only the rows untrusted turns
 * wrote ({@link filterMessagesForUntrustedActor}). A participant in a shared
 * conversation already reads its whole transcript through the shared read
 * routes, so their turn is given that transcript, and only that:
 *
 * - A row an untrusted turn wrote loads as it is stored, exactly as it does
 *   for any untrusted actor.
 * - Every other row loads as its contact projection, the form the shared read
 *   routes show it in. Reasoning, tool calls and their results, and cards
 *   stay out, and the row's metadata is dropped, so nothing injected into the
 *   turn that wrote it (memory, workspace, turn context, NOW.md) is
 *   rehydrated. The projection also drops injected blocks still embedded in
 *   older user rows.
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
import { isRowVisibleToUntrustedActor } from "./message-provenance.js";
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

/** The rows a shared-conversation participant's turn loads, in order. */
export function scopeRowsForSharedReader(
  rows: MessageRow[],
  reader: ContactReader,
): MessageRow[] {
  const scoped: MessageRow[] = [];
  for (const row of rows) {
    if (isRowVisibleToUntrustedActor(row.metadata)) {
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

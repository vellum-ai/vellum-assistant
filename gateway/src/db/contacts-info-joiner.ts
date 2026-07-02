/**
 * Batch read of informational (assistant-owned) contact fields.
 *
 * Per the ACL/info split (see memory/concepts/decision/contact-data-split.md
 * and the comment block in schema.ts), the gateway DB owns ACL data and the
 * assistant DB owns purely informational data: `notes`, `userFile`,
 * `contactType`, and `assistant_contact_metadata` (species + metadata blob).
 *
 * This module performs a SINGLE typed IPC read against the assistant DB (via
 * `contacts_info_batch`) for a set of contact IDs and returns the info fields
 * keyed by contact ID. The caller (ContactStore) is responsible for soft-fail
 * handling if this throws — the ACL shape must remain servable when the
 * assistant DB is unreachable.
 */

import { fetchContactsInfoBatch } from "../ipc/contacts-info-client.js";

export interface ContactInfoFields {
  notes: string | null;
  userFile: string | null;
  contactType: string | null;
  assistantMetadata: {
    species: string;
    metadata: Record<string, unknown> | null;
  } | null;
}

const EMPTY_INFO: ContactInfoFields = {
  notes: null,
  userFile: null,
  contactType: null,
  assistantMetadata: null,
};

/**
 * Fetch informational fields for a batch of contact IDs from the assistant DB.
 *
 * - Returns an empty Map when `contactIds` is empty (no query issued).
 * - Contacts present in the gateway but missing from the assistant DB are
 *   simply absent from the returned Map; the caller treats a missing entry as
 *   "info unavailable" (all-null fields).
 * - If the IPC read throws, the error propagates — the caller decides
 *   soft-fail vs hard-fail. Per the decision, the caller soft-fails so the
 *   ACL list remains servable.
 *
 * The read is a single `contacts_info_batch` IPC call; the daemon left-joins
 * `assistant_contact_metadata` and applies the metadata gating + JSON parse, so
 * `assistantMetadata` arrives already shaped.
 */
export async function fetchInfoForContacts(
  contactIds: string[],
): Promise<Map<string, ContactInfoFields>> {
  const result = new Map<string, ContactInfoFields>();
  if (contactIds.length === 0) return result;

  const infos = await fetchContactsInfoBatch(contactIds);
  for (const info of infos) {
    result.set(info.contactId, {
      notes: info.notes,
      userFile: info.userFile,
      contactType: info.contactType,
      assistantMetadata: info.assistantMetadata,
    });
  }

  return result;
}

/**
 * Convenience: a frozen all-null info object for callers that need a default
 * when a contact is missing from the assistant DB or the assistant DB is down.
 */
export function emptyContactInfo(): ContactInfoFields {
  return { ...EMPTY_INFO };
}

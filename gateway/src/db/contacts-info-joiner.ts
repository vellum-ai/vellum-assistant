/**
 * Batch read of informational (assistant-owned) contact fields.
 *
 * Per the ACL/info split (see memory/concepts/decision/contact-data-split.md
 * and the comment block in schema.ts), the gateway DB owns ACL data and the
 * assistant DB owns purely informational data: `notes`, `userFile`,
 * `contactType`, and `assistant_contact_metadata` (species + metadata blob).
 *
 * This module performs a SINGLE batched query against the assistant DB (via
 * `assistantDbQuery`) for a set of contact IDs and returns the info fields
 * keyed by contact ID. The caller (ContactStore) is responsible for soft-fail
 * handling if this throws — the ACL shape must remain servable when the
 * assistant DB is unreachable.
 */

import { type SqliteValue, assistantDbQuery } from "./assistant-db-proxy.js";

export interface ContactInfoFields {
  notes: string | null;
  userFile: string | null;
  contactType: string | null;
  assistantMetadata: {
    species: string;
    metadata: Record<string, unknown> | null;
  } | null;
}

interface AssistantInfoRow {
  id: string;
  notes: string | null;
  userFile: string | null;
  contactType: string | null;
  species: string | null;
  metadata: string | null;
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
 * - If `assistantDbQuery` throws, the error propagates — the caller decides
 *   soft-fail vs hard-fail. Per the decision, the caller soft-fails so the
 *   ACL list remains servable.
 *
 * The query is a single SELECT with a dynamically-sized `IN (...)` clause,
 * left-joining `assistant_contact_metadata` so species/metadata come back in
 * the same round trip. `metadata` is stored as a JSON text blob and is parsed
 * here; a malformed blob becomes `null` (logged, not thrown).
 */
export async function fetchInfoForContacts(
  contactIds: string[],
): Promise<Map<string, ContactInfoFields>> {
  const result = new Map<string, ContactInfoFields>();
  if (contactIds.length === 0) return result;

  const placeholders = contactIds.map(() => "?").join(", ");
  const bind = contactIds as SqliteValue[];

  const rows = await assistantDbQuery<AssistantInfoRow>(
    `SELECT c.id            AS id,
            c.notes         AS notes,
            c.user_file     AS userFile,
            c.contact_type  AS contactType,
            m.species       AS species,
            m.metadata      AS metadata
       FROM contacts c
       LEFT JOIN assistant_contact_metadata m ON m.contact_id = c.id
      WHERE c.id IN (${placeholders})`,
    bind,
  );

  for (const row of rows) {
    let parsedMetadata: Record<string, unknown> | null = null;
    if (row.metadata) {
      try {
        parsedMetadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        // Malformed JSON blob — degrade to null rather than failing the read.
        parsedMetadata = null;
      }
    }

    const info: ContactInfoFields = {
      notes: row.notes ?? null,
      userFile: row.userFile ?? null,
      contactType: row.contactType ?? null,
      // Gate metadata on contactType === "assistant" to match the daemon's
      // contract (assistant/src/runtime/routes/contact-routes.ts:187). A
      // stale metadata row on a human contact is not emitted.
      assistantMetadata:
        row.contactType === "assistant" && row.species != null
          ? { species: row.species, metadata: parsedMetadata }
          : null,
    };
    result.set(row.id, info);
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

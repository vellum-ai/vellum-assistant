/**
 * IPC-only contact INFO-READ methods called by the gateway over the assistant
 * IPC socket (`ipcCallAssistant`).
 *
 * These replace the gateway's raw `db_proxy` SELECTs against the assistant DB
 * with typed, zod-validated reads of the assistant-owned informational fields
 * (`notes`, `user_file`, `contact_type`, `assistant_contact_metadata`) and
 * contact-channel identity. ACL data stays gateway-owned; these methods never
 * touch it.
 *
 * Like the invite IPC methods, they have no HTTP surface: they are registered
 * directly on the IPC server (see `assistant-server.ts`) and never enter the
 * shared `ROUTES` array, so they can never reach the gateway's HTTP IPC proxy
 * route schema.
 */

import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../persistence/db-connection.js";
import {
  assistantContactMetadata,
  contactChannels,
  contacts,
} from "../../persistence/schema/index.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

/**
 * Derive the daemon-owned assistant-metadata block. Gated on
 * `contactType === "assistant"` so a stale metadata row on a human contact is
 * never emitted (matches the daemon rich-read contract). A malformed JSON blob
 * degrades to `null` metadata rather than throwing.
 */
function toAssistantMetadata(
  contactType: string | null,
  species: string | null,
  metadataText: string | null,
): { species: string; metadata: Record<string, unknown> | null } | null {
  if (contactType !== "assistant" || species == null) return null;
  let metadata: Record<string, unknown> | null = null;
  if (metadataText) {
    try {
      metadata = JSON.parse(metadataText) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return { species, metadata };
}

// ---------------------------------------------------------------------------
// contacts_info_batch
// ---------------------------------------------------------------------------

const ContactsInfoBatchParamsSchema = z.object({
  contactIds: z.array(z.string()),
});

/**
 * Batch read of the assistant-owned info fields for a set of contact IDs.
 * Replaces the info-joiner's raw SELECT. Contacts absent from the assistant DB
 * are simply omitted; the caller treats a missing entry as "info unavailable".
 */
export function handleContactsInfoBatch({ body = {} }: RouteHandlerArgs) {
  const { contactIds } = ContactsInfoBatchParamsSchema.parse(body);
  if (contactIds.length === 0) return { infos: [] };

  const db = getDb();
  const rows = db
    .select({
      id: contacts.id,
      notes: contacts.notes,
      userFile: contacts.userFile,
      contactType: contacts.contactType,
      species: assistantContactMetadata.species,
      metadata: assistantContactMetadata.metadata,
    })
    .from(contacts)
    .leftJoin(
      assistantContactMetadata,
      eq(assistantContactMetadata.contactId, contacts.id),
    )
    .where(inArray(contacts.id, contactIds))
    .all();

  const infos = rows.map((row) => ({
    contactId: row.id,
    notes: row.notes ?? null,
    userFile: row.userFile ?? null,
    contactType: row.contactType ?? null,
    assistantMetadata: toAssistantMetadata(
      row.contactType,
      row.species,
      row.metadata,
    ),
  }));
  return { infos };
}

// ---------------------------------------------------------------------------
// contact_channel_identity_lookup
// ---------------------------------------------------------------------------

const ChannelIdentityLookupParamsSchema = z
  .object({
    channelId: z.string().optional(),
    type: z.string().optional(),
    address: z.string().optional(),
  })
  .refine(
    (v) => v.channelId != null || (v.type != null && v.address != null),
    { message: "Provide channelId, or both type and address" },
  );

const CHANNEL_IDENTITY_PROJECTION = {
  id: contactChannels.id,
  contactId: contactChannels.contactId,
  type: contactChannels.type,
  address: contactChannels.address,
  externalChatId: contactChannels.externalChatId,
  displayName: contacts.displayName,
};

/**
 * Resolve a contact-channel identity by `channelId` OR by logical
 * `(type, address)` (COLLATE NOCASE). Replaces the raw identity SELECTs in the
 * verification helpers and the gateway channel resolver. Returns the channel's
 * identity fields (no ACL/status). The unique `(type, address)` index is
 * case-sensitive while this lookup is NOCASE, so case-variant duplicates can
 * match; they resolve to the most-recently-updated row.
 */
export function handleContactChannelIdentityLookup({
  body = {},
}: RouteHandlerArgs) {
  const params = ChannelIdentityLookupParamsSchema.parse(body);
  const db = getDb();

  const where =
    params.channelId != null
      ? eq(contactChannels.id, params.channelId)
      : and(
          eq(contactChannels.type, params.type!),
          sql`${contactChannels.address} = ${params.address!} COLLATE NOCASE`,
        );

  const row = db
    .select(CHANNEL_IDENTITY_PROJECTION)
    .from(contactChannels)
    .innerJoin(contacts, eq(contacts.id, contactChannels.contactId))
    .where(where)
    .orderBy(desc(contactChannels.updatedAt))
    .get();

  return { channel: row ?? null };
}

// ---------------------------------------------------------------------------
// contact_mirror_probe
// ---------------------------------------------------------------------------

const ContactMirrorProbeParamsSchema = z.object({ contactId: z.string() });

/**
 * Probe the assistant mirror for one contact: whether the row and any channels
 * exist, the guardian-authored info fields, and whether an assistant-metadata
 * row is present. Feeds the gateway orphan-veto and delete-target decisions.
 */
export function handleContactMirrorProbe({ body = {} }: RouteHandlerArgs) {
  const { contactId } = ContactMirrorProbeParamsSchema.parse(body);
  const db = getDb();

  const contactRow = db
    .select({
      notes: contacts.notes,
      userFile: contacts.userFile,
      contactType: contacts.contactType,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();

  const channelRow = db
    .select({ id: contactChannels.id })
    .from(contactChannels)
    .where(eq(contactChannels.contactId, contactId))
    .limit(1)
    .get();

  const metadataRow = db
    .select({ contactId: assistantContactMetadata.contactId })
    .from(assistantContactMetadata)
    .where(eq(assistantContactMetadata.contactId, contactId))
    .limit(1)
    .get();

  return {
    exists: contactRow != null,
    hasChannels: channelRow != null,
    notes: contactRow?.notes ?? null,
    userFile: contactRow?.userFile ?? null,
    contactType: contactRow?.contactType ?? null,
    hasMetadata: metadataRow != null,
  };
}

// ---------------------------------------------------------------------------
// contact_user_file_slugs
// ---------------------------------------------------------------------------

const ContactUserFileSlugsParamsSchema = z.object({ prefix: z.string() });

/**
 * List the `user_file` slugs matching `prefix%`. Feeds the gateway's
 * collision-suffixed slug allocation for a new contact.
 */
export function handleContactUserFileSlugs({ body = {} }: RouteHandlerArgs) {
  const { prefix } = ContactUserFileSlugsParamsSchema.parse(body);
  const db = getDb();
  const rows = db
    .select({ userFile: contacts.userFile })
    .from(contacts)
    .where(like(contacts.userFile, `${prefix}%`))
    .all();
  const userFiles = rows
    .map((r) => r.userFile)
    .filter((f): f is string => f != null);
  return { userFiles };
}

/**
 * IPC-only contact info-read methods, keyed by IPC operationId. Registered
 * directly on the assistant IPC server (see `assistant-server.ts`).
 */
export const CONTACTS_INFO_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  contacts_info_batch: handleContactsInfoBatch,
  contact_channel_identity_lookup: handleContactChannelIdentityLookup,
  contact_mirror_probe: handleContactMirrorProbe,
  contact_user_file_slugs: handleContactUserFileSlugs,
};

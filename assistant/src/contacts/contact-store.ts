import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { ChannelId } from "../channels/types.js";
import { getDb } from "../persistence/db-connection.js";
import {
  assistantContactMetadata,
  contactChannels,
  contacts,
} from "../persistence/schema/index.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { notifyContactsChanged } from "./notify-contacts-changed.js";
import type {
  AssistantContactMetadata,
  Contact,
  ContactChannel,
  ContactType,
  ContactWithChannels,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────

type Db = ReturnType<typeof getDb>;
/** Accepts the live connection or a transaction handle. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Strip LIKE metacharacters so user input is matched literally.
 * SQLite has no default escape character for LIKE, so we strip rather than escape. */
function escapeLike(value: string): string {
  return value.replace(/%/g, "").replace(/_/g, "");
}

/**
 * Find the first contact_channels row whose (type, address) matches.
 * Uses COLLATE NOCASE to find legacy lowercased rows (pre-migration 290).
 */
function findConflictingChannel(db: DbOrTx, type: string, address: string) {
  return db
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, type),
        sql`${contactChannels.address} = ${address} COLLATE NOCASE`,
      ),
    )
    .get();
}

/** Merge notes concat: survivor notes first, donor appended with \n,
 * empty result stored as null. */
function concatMergedNotes(
  keepNotes: string | null | undefined,
  donorNotes: string | null,
): string | null {
  return [keepNotes ?? null, donorNotes].filter(Boolean).join("\n") || null;
}

/**
 * Move donor channels onto the survivor, skipping any the survivor already
 * holds by logical (type, address) key. COLLATE NOCASE catches legacy
 * lowercased rows. `touchUpdatedAt` stamps updated_at on moved rows.
 */
function reparentDonorChannels(
  tx: DbOrTx,
  keepId: string,
  mergeId: string,
  touchUpdatedAt: number,
): void {
  const donorChannels = tx
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.contactId, mergeId))
    .all();

  for (const ch of donorChannels) {
    const exists = tx
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.contactId, keepId),
          eq(contactChannels.type, ch.type),
          sql`${contactChannels.address} = ${ch.address} COLLATE NOCASE`,
        ),
      )
      .get();

    if (!exists) {
      tx.update(contactChannels)
        .set({ contactId: keepId, updatedAt: touchUpdatedAt })
        .where(eq(contactChannels.id, ch.id))
        .run();
    }
  }
}

/**
 * Pure slug transform applied to a display name. No DB lookup, no collision
 * handling — callers that need a collision-free filename should use
 * `generateUserFileSlug` instead. Exported so the migration classifier can
 * recompute the expected base slug for a given display name.
 */
export function computeUserFileBaseSlug(displayName: string): string {
  return (
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "user"
  );
}

/**
 * Generate a collision-free slugified filename for a contact's per-user persona file.
 * Produces filenames like "alice.md", "alice-2.md", "alice-3.md", etc.
 */
export function generateUserFileSlug(displayName: string): string {
  const slug = computeUserFileBaseSlug(displayName);

  const db = getDb();
  const rows = db
    .select({ userFile: contacts.userFile })
    .from(contacts)
    .where(like(contacts.userFile, `${escapeLike(slug)}%`))
    .all();

  const taken = new Set(rows.map((r) => r.userFile?.toLowerCase()));

  const base = `${slug}.md`;
  if (!taken.has(base)) return base;

  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

function parseContact(row: typeof contacts.$inferSelect): Contact {
  return {
    id: row.id,
    displayName: row.displayName,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contactType: row.contactType,
    userFile: row.userFile ?? null,
  };
}

function parseChannel(
  row: typeof contactChannels.$inferSelect,
): ContactChannel {
  return {
    id: row.id,
    contactId: row.contactId,
    type: row.type,
    address: row.address,
    isPrimary: row.isPrimary,
    externalChatId: row.externalChatId,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

function getChannelsForContact(contactId: string): ContactChannel[] {
  const db = getDb();
  const rows = db
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.contactId, contactId))
    .orderBy(desc(contactChannels.isPrimary), asc(contactChannels.createdAt))
    .all();
  return rows.map(parseChannel);
}

function withChannels(contact: Contact): ContactWithChannels {
  const channels = getChannelsForContact(contact.id);
  return { ...contact, channels };
}

// ── Channel data type for syncChannels ───────────────────────────────

interface SyncChannelData {
  /** Explicit gateway-minted channel id. Lets the identity mirror key the
   *  channel identically in both stores; omit to mint one. When a row with this
   *  id already exists it is updated in place (address/owner rebind), so a
   *  gateway re-auth is mirrored rather than colliding on the id. */
  id?: string;
  type: string;
  address: string;
  isPrimary?: boolean;
  externalChatId?: string | null;
}

// ── CRUD ─────────────────────────────────────────────────────────────

/** Retrieve a contact by ID. */
export function getContact(id: string): ContactWithChannels | null {
  const db = getDb();
  const row = db.select().from(contacts).where(eq(contacts.id, id)).get();
  if (!row) return null;
  return withChannels(parseContact(row));
}

/** INFO-only contact fields, joined locally by contact ID. */
export interface ContactInfo {
  notes: string | null;
}

/**
 * Look up a contact's INFO `notes` field by ID.
 *
 * Carries no ACL state (status/policy/verification) or interaction telemetry —
 * those are owned by the gateway (ACL via the stamped trust verdict, telemetry
 * via the verdict/rich reads). Returns null when the contact does not exist.
 */
export function findContactInfoById(contactId: string): ContactInfo | null {
  const contact = getContact(contactId);
  if (!contact) return null;
  return {
    notes: contact.notes,
  };
}

/**
 * Look up a single contact channel by its primary key.
 * Returns the parsed channel row, or null if it does not exist.
 */
export function getChannelById(channelId: string): ContactChannel | null {
  const db = getDb();
  const row = db
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.id, channelId))
    .get();
  return row ? parseChannel(row) : null;
}

export function upsertContact(params: {
  id?: string;
  displayName: string;
  notes?: string | null;
  contactType?: ContactType;
  userFile?: string | null;
  /** userFile to seed ONLY when inserting a new contact; ignored on update so
   *  an existing persona-file pointer is never clobbered. Used by the identity
   *  mirror to create faithful null-user_file stubs. `userFile` takes
   *  precedence when both are supplied. */
  userFileOnCreate?: string | null;
  channels?: SyncChannelData[];
  /** When true, conflicting channels on other contacts are reassigned to this
   *  contact instead of being skipped. Used by invite redemption to bind a
   *  redeemer's existing channel identity to the invite's target contact. */
  reassignConflictingChannels?: boolean;
}): ContactWithChannels & { created: boolean } {
  const db = getDb();
  const now = Date.now();

  // Canonicalize all channel addresses up front so every downstream path
  // (lookups, inserts, conflict checks) uses the canonical form.
  const canonicalChannels = params.channels?.map((ch) => ({
    ...ch,
    address:
      canonicalizeInboundIdentity(ch.type as ChannelId, ch.address) ??
      ch.address,
  }));

  let contactId = params.id;

  // If an ID is provided, check if the contact exists for update
  if (contactId) {
    const existing = db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .get();
    if (existing) {
      const updateSet: Record<string, unknown> = {
        displayName: params.displayName,
        updatedAt: now,
      };
      if (params.notes !== undefined) updateSet.notes = params.notes;
      if (params.contactType !== undefined)
        updateSet.contactType = params.contactType;
      if (params.userFile !== undefined) updateSet.userFile = params.userFile;

      db.update(contacts)
        .set(updateSet)
        .where(eq(contacts.id, contactId))
        .run();

      if (canonicalChannels) {
        syncChannels(
          contactId,
          canonicalChannels,
          now,
          params.reassignConflictingChannels,
        );
      }

      notifyContactsChanged();
      return { ...getContact(contactId)!, created: false };
    }
  }

  // Try to find by channel canonical identity to avoid duplicates
  if (!contactId && canonicalChannels && canonicalChannels.length > 0) {
    for (const ch of canonicalChannels) {
      const existingChannel = findConflictingChannel(db, ch.type, ch.address);

      if (existingChannel) {
        contactId = existingChannel.contactId;
        const updateSet: Record<string, unknown> = {
          displayName: params.displayName,
          updatedAt: now,
        };
        if (params.notes !== undefined) updateSet.notes = params.notes;
        if (params.contactType !== undefined)
          updateSet.contactType = params.contactType;
        if (params.userFile !== undefined) updateSet.userFile = params.userFile;

        db.update(contacts)
          .set(updateSet)
          .where(eq(contacts.id, contactId))
          .run();

        syncChannels(contactId, canonicalChannels, now);
        notifyContactsChanged();
        return { ...getContact(contactId)!, created: false };
      }
    }
  }

  // Create new contact
  contactId = contactId ?? uuid();
  const resolvedUserFile =
    params.userFile !== undefined
      ? params.userFile
      : params.userFileOnCreate !== undefined
        ? params.userFileOnCreate
        : generateUserFileSlug(params.displayName);
  db.insert(contacts)
    .values({
      id: contactId,
      displayName: params.displayName,
      notes: params.notes ?? null,
      contactType: params.contactType ?? "human",
      userFile: resolvedUserFile,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  if (canonicalChannels) {
    syncChannels(
      contactId,
      canonicalChannels,
      now,
      params.reassignConflictingChannels,
    );
  }

  notifyContactsChanged();
  return { ...getContact(contactId)!, created: true };
}

/**
 * Delete a contact row (channels cascade via FK). Info-only: the gateway DB is
 * the ACL source of truth, so this only removes the local identity mirror. A
 * missing row is a harmless no-op.
 */
export function deleteContact(id: string): void {
  getDb().delete(contacts).where(eq(contacts.id, id)).run();
  notifyContactsChanged();
}

/**
 * Add new channels to a contact without removing existing ones.
 * When a channel already exists (same type+address), refreshes its identity
 * fields (address casing, isPrimary, externalChatId) if provided. Skips
 * channels owned by a different contact unless reassignment is requested.
 */
function syncChannels(
  contactId: string,
  channels: SyncChannelData[],
  now: number,
  reassignConflicting?: boolean,
): void {
  const db = getDb();

  for (const ch of channels) {
    // Identity-mirror update-by-id: when the caller supplies the gateway's
    // authoritative channel id and that row already exists, update it in place.
    // The gateway can rebind the row's address (guardian re-auth) or owner
    // (claimed channel) under a stable id, so a match by (contactId,type,address)
    // would miss it and a fresh insert would collide on the primary key.
    if (ch.id) {
      const byId = db
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.id, ch.id))
        .get();
      if (byId) {
        const crossContact = byId.contactId !== contactId;
        // Never steal a channel the gateway left under another contact unless
        // the caller opts into reassignment (mirrors the address-conflict path).
        if (crossContact && !reassignConflicting) continue;

        const updateSet: Record<string, unknown> = { updatedAt: now };
        if (byId.address !== ch.address) {
          // Rebinding to a new address: a DIFFERENT row may already hold
          // (type, new-address), and idx_contact_channels_type_address would
          // reject the move. Resolve it the same way the (contactId,type,address)
          // path does — findConflictingChannel + the reassign gate. When
          // reassigning, adopt the (type,address) identity onto this
          // gateway-keyed row by removing the stale duplicate; otherwise leave
          // the address so the existing mapping stands (onConflictDoNothing).
          const conflicting = findConflictingChannel(db, ch.type, ch.address);
          if (conflicting && conflicting.id !== ch.id) {
            if (reassignConflicting) {
              db.delete(contactChannels)
                .where(eq(contactChannels.id, conflicting.id))
                .run();
              updateSet.address = ch.address;
            }
          } else {
            updateSet.address = ch.address;
          }
        }
        if (crossContact) updateSet.contactId = contactId;
        if (ch.isPrimary !== undefined) updateSet.isPrimary = ch.isPrimary;
        if (ch.externalChatId !== undefined)
          updateSet.externalChatId = ch.externalChatId;

        db.update(contactChannels)
          .set(updateSet)
          .where(eq(contactChannels.id, ch.id))
          .run();
        continue;
      }
    }

    // Match by (type, address) — the canonical identity for all channel types.
    // COLLATE NOCASE catches legacy rows that were lowercased by old write paths.
    const existing = db
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.contactId, contactId),
          eq(contactChannels.type, ch.type),
          sql`${contactChannels.address} = ${ch.address} COLLATE NOCASE`,
        ),
      )
      .get();

    if (existing) {
      const updateSet: Record<string, unknown> = {};
      // Self-heal legacy lowercased addresses to canonical form.
      if (existing.address !== ch.address) updateSet.address = ch.address;
      if (ch.isPrimary !== undefined) updateSet.isPrimary = ch.isPrimary;
      if (ch.externalChatId !== undefined)
        updateSet.externalChatId = ch.externalChatId;

      if (Object.keys(updateSet).length > 0) {
        updateSet.updatedAt = now;
        db.update(contactChannels)
          .set(updateSet)
          .where(eq(contactChannels.id, existing.id))
          .run();
      }
      continue;
    }

    // Check if this channel's canonical identity conflicts with another contact.
    const conflicting = findConflictingChannel(db, ch.type, ch.address);

    if (conflicting) {
      if (reassignConflicting) {
        // Reassign the channel to the target contact. Used by invite redemption
        // to bind a redeemer's existing channel identity to the invite's target.
        const reassignSet: Record<string, unknown> = {
          contactId,
          updatedAt: now,
        };
        if (ch.externalChatId !== undefined)
          reassignSet.externalChatId = ch.externalChatId;
        if (ch.isPrimary !== undefined) reassignSet.isPrimary = ch.isPrimary;

        db.update(contactChannels)
          .set(reassignSet)
          .where(eq(contactChannels.id, conflicting.id))
          .run();
      }
      // When not reassigning, skip to avoid unique constraint violation.
      // The caller should use contact_merge to combine the two contacts.
      continue;
    }

    db.insert(contactChannels)
      .values({
        id: ch.id ?? uuid(),
        contactId,
        type: ch.type,
        address: ch.address,
        isPrimary: ch.isPrimary ?? false,
        externalChatId: ch.externalChatId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

export function searchContacts(params: {
  query?: string;
  channelAddress?: string;
  channelType?: string;
  contactType?: ContactType;
  limit?: number;
}): ContactWithChannels[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(params.limit ?? 20, 100));

  // Search by channel address first (exact or partial match)
  if (params.channelAddress) {
    const escapedAddress = escapeLike(params.channelAddress);
    if (!escapedAddress) return [];
    const channelRows = db
      .select({ contactId: contactChannels.contactId })
      .from(contactChannels)
      .innerJoin(contacts, eq(contactChannels.contactId, contacts.id))
      .where(
        params.channelType
          ? and(
              eq(contactChannels.type, params.channelType),
              like(contactChannels.address, `%${escapedAddress}%`),
            )
          : and(like(contactChannels.address, `%${escapedAddress}%`)),
      )
      .all();

    const contactIds = [...new Set(channelRows.map((r) => r.contactId))];
    if (contactIds.length === 0) return [];

    // Pre-compute the sanitized query for display-name filtering so the
    // loop body stays cheap.
    const sanitizedQuery = params.query
      ? escapeLike(params.query).toLowerCase()
      : undefined;

    const results: ContactWithChannels[] = [];
    for (const id of contactIds) {
      if (results.length >= limit) break;
      const contact = getContact(id);
      if (
        contact &&
        (!params.contactType || contact.contactType === params.contactType) &&
        (!sanitizedQuery ||
          (contact.displayName &&
            contact.displayName.toLowerCase().includes(sanitizedQuery)))
      ) {
        results.push(contact);
      }
    }
    return results;
  }

  // Search by channel type alone (no address)
  if (params.channelType && !params.query) {
    const channelRows = db
      .select({ contactId: contactChannels.contactId })
      .from(contactChannels)
      .innerJoin(contacts, eq(contactChannels.contactId, contacts.id))
      .where(eq(contactChannels.type, params.channelType))
      .all();

    const contactIds = [...new Set(channelRows.map((r) => r.contactId))];
    if (contactIds.length === 0) return [];

    const results: ContactWithChannels[] = [];
    for (const id of contactIds) {
      if (results.length >= limit) break;
      const contact = getContact(id);
      if (
        contact &&
        (!params.contactType || contact.contactType === params.contactType)
      ) {
        results.push(contact);
      }
    }
    return results;
  }

  // Search by display name, optionally filtered by channelType
  const conditions = [];
  if (params.query) {
    const sanitized = escapeLike(params.query);
    if (!sanitized && !params.contactType) return [];
    if (sanitized) {
      conditions.push(like(contacts.displayName, `%${sanitized}%`));
    }
  }
  if (params.contactType) {
    conditions.push(eq(contacts.contactType, params.contactType));
  }
  if (params.channelType) {
    conditions.push(eq(contactChannels.type, params.channelType));
  }

  const whereClause =
    conditions.length > 1 ? and(...conditions) : conditions[0];

  // Join with contactChannels when channelType is specified so the filter
  // can reference the channel table; otherwise query contacts alone.
  if (params.channelType) {
    const rows = db
      .select({ contactId: contacts.id })
      .from(contacts)
      .innerJoin(contactChannels, eq(contacts.id, contactChannels.contactId))
      .where(whereClause)
      .orderBy(desc(contacts.updatedAt))
      .all();

    const contactIds = [...new Set(rows.map((r) => r.contactId))];
    if (contactIds.length === 0) return [];

    const results: ContactWithChannels[] = [];
    for (const id of contactIds) {
      if (results.length >= limit) break;
      const contact = getContact(id);
      if (contact) {
        results.push(contact);
      }
    }
    return results;
  }

  const rows = db
    .select()
    .from(contacts)
    .where(whereClause)
    .orderBy(desc(contacts.updatedAt))
    .limit(limit)
    .all();

  return rows.map((r) => withChannels(parseContact(r)));
}

export function listContacts(
  limit = 50,
  contactType?: ContactType,
  opts?: { uncapped?: boolean },
): ContactWithChannels[] {
  const db = getDb();
  const effectiveLimit = opts?.uncapped ? limit : Math.min(limit, 200);
  const rows = db
    .select()
    .from(contacts)
    .where(contactType ? eq(contacts.contactType, contactType) : undefined)
    .orderBy(desc(contacts.updatedAt))
    .limit(effectiveLimit)
    .all();
  return rows.map((r) => withChannels(parseContact(r)));
}

/**
 * Identity-mirror merge for the gateway's `contacts_mirror_merge_contact` op:
 * concat donor notes onto the survivor (notes-only — never clobbers the
 * survivor's display name), reparent donor channels by (type, address
 * NOCASE), delete the donor. One transaction. A donor already gone is a no-op
 * (idempotent gateway retry); a survivor missing from the mirror (mirror
 * drift) is inserted with the combined notes so donor notes survive the
 * delete.
 */
export function mergeContactMirror(params: {
  keepContactId: string;
  mergeContactId: string;
  keepDisplayName: string;
  resolvedUserFile?: string;
}): void {
  const db = getDb();

  const applied = db.transaction((tx) => {
    const donor = tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, params.mergeContactId))
      .get();
    if (!donor) return false;

    const now = Date.now();
    const survivor = tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, params.keepContactId))
      .get();
    const combined = concatMergedNotes(survivor?.notes, donor.notes);

    if (survivor) {
      tx.update(contacts)
        .set({ notes: combined, updatedAt: now })
        .where(eq(contacts.id, params.keepContactId))
        .run();
    } else {
      tx.insert(contacts)
        .values({
          id: params.keepContactId,
          displayName: params.keepDisplayName,
          notes: combined,
          contactType: "human",
          userFile: params.resolvedUserFile ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // Move donor channels to the survivor, skipping duplicates by logical key.
    reparentDonorChannels(tx, params.keepContactId, params.mergeContactId, now);

    // Delete the donor (cascade removes remaining duplicate channels).
    tx.delete(contacts).where(eq(contacts.id, params.mergeContactId)).run();
    return true;
  });

  if (applied) notifyContactsChanged();
}

/**
 * Full identity-mirror upsert for the gateway's `contacts_mirror_upsert_full`
 * op. One transaction:
 *
 * - Existing contact: sparse omit-to-preserve UPDATE — only provided fields
 *   change (a partial upsert can't clobber notes/contact_type or revert a
 *   curated display name).
 * - Missing contact: INSERT with a generated collision-free user_file slug
 *   (display name falls back to the first channel address, then "Unknown").
 * - `assistant_contact_metadata` is upserted only for assistant-type contacts.
 * - Channels: an existing (type, address NOCASE) row on this contact gets an
 *   omit-to-preserve external_chat_id refresh; an address owned by ANOTHER
 *   contact is skipped (never stolen); a new row adopts the gateway-minted
 *   channel id so both stores share one canonical id.
 */
export function upsertContactMirrorFull(params: {
  contactId: string;
  displayName?: string;
  notes?: string | null;
  contactType?: ContactType;
  assistantMetadata?: {
    species: string;
    metadata?: Record<string, unknown> | null;
  };
  channels?: {
    id?: string;
    type: string;
    address: string;
    isPrimary?: boolean;
    externalChatId?: string | null;
  }[];
}): void {
  const db = getDb();

  db.transaction((tx) => {
    const now = Date.now();
    const existing = tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, params.contactId))
      .get();

    if (existing) {
      const updateSet: Record<string, unknown> = { updatedAt: now };
      if (params.displayName !== undefined) {
        updateSet.displayName = params.displayName;
      }
      if (params.notes !== undefined) updateSet.notes = params.notes;
      if (params.contactType !== undefined) {
        updateSet.contactType = params.contactType;
      }
      tx.update(contacts)
        .set(updateSet)
        .where(eq(contacts.id, params.contactId))
        .run();
    } else {
      const displayName =
        params.displayName ?? params.channels?.[0]?.address ?? "Unknown";
      tx.insert(contacts)
        .values({
          id: params.contactId,
          displayName,
          notes: params.notes ?? null,
          contactType: params.contactType ?? "human",
          userFile: generateUserFileSlug(displayName),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    if (params.contactType === "assistant" && params.assistantMetadata) {
      const metadataJson =
        params.assistantMetadata.metadata != null
          ? JSON.stringify(params.assistantMetadata.metadata)
          : null;
      tx.insert(assistantContactMetadata)
        .values({
          contactId: params.contactId,
          species: params.assistantMetadata.species,
          metadata: metadataJson,
        })
        .onConflictDoUpdate({
          target: assistantContactMetadata.contactId,
          set: {
            species: params.assistantMetadata.species,
            metadata: metadataJson,
          },
        })
        .run();
    }

    for (const ch of params.channels ?? []) {
      const existingCh = tx
        .select()
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.contactId, params.contactId),
            eq(contactChannels.type, ch.type),
            sql`${contactChannels.address} = ${ch.address} COLLATE NOCASE`,
          ),
        )
        .get();

      if (existingCh) {
        // Omit-to-preserve external_chat_id; is_primary is never rewritten
        // on an existing channel.
        const updateSet: Record<string, unknown> = { updatedAt: now };
        if (ch.externalChatId !== undefined) {
          updateSet.externalChatId = ch.externalChatId;
        }
        tx.update(contactChannels)
          .set(updateSet)
          .where(eq(contactChannels.id, existingCh.id))
          .run();
        continue;
      }

      // Address owned by ANOTHER contact is never stolen.
      if (findConflictingChannel(tx, ch.type, ch.address)) continue;

      tx.insert(contactChannels)
        .values({
          id: ch.id ?? uuid(),
          contactId: params.contactId,
          type: ch.type,
          address: ch.address,
          isPrimary: ch.isPrimary ?? false,
          externalChatId: ch.externalChatId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  });

  notifyContactsChanged();
}

/**
 * Find a contact by a specific channel address. Returns null if not found.
 * Canonicalizes the address before querying. Uses COLLATE NOCASE to match
 * legacy lowercased rows that migration 290 couldn't restore.
 */
export function findContactByAddress(
  type: string,
  address: string,
): ContactWithChannels | null {
  const canonical =
    canonicalizeInboundIdentity(type as ChannelId, address) ?? address;
  const db = getDb();
  const channel = db
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, type),
        sql`${contactChannels.address} = ${canonical} COLLATE NOCASE`,
      ),
    )
    .get();

  if (!channel) return null;
  return getContact(channel.contactId);
}

/**
 * Find a contact by channel external chat ID. Fallback for callers that only
 * have a chat ID (no user-level address) — matches by (type, externalChatId).
 * No unique constraint exists on externalChatId, so ORDER BY is needed for a
 * deterministic pick; channel ranking (status) is owned by the gateway now.
 */
function findContactByChannelExternalChatId(
  channelType: string,
  externalChatId: string,
): ContactWithChannels | null {
  const db = getDb();
  const channel = db
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, channelType),
        eq(contactChannels.externalChatId, externalChatId),
      ),
    )
    .orderBy(desc(contactChannels.updatedAt), desc(contactChannels.createdAt))
    .get();
  if (!channel) return null;
  return getContact(channel.contactId);
}

/**
 * Find a contact and matching channel by trying address first, then
 * falling back to externalChatId. Mirrors the findMember lookup strategy.
 */
export function findContactChannel(params: {
  channelType: string;
  address?: string;
  externalChatId?: string;
}): { contact: ContactWithChannels; channel: ContactChannel } | null {
  if (params.address) {
    const canonical =
      canonicalizeInboundIdentity(
        params.channelType as ChannelId,
        params.address,
      ) ?? params.address;
    const contact = findContactByAddress(params.channelType, canonical);
    if (contact) {
      const ch = contact.channels.find(
        (c) =>
          c.type === params.channelType &&
          c.address.toLowerCase() === canonical.toLowerCase(),
      );
      if (ch) return { contact, channel: ch };
    }
  }
  if (params.externalChatId) {
    const contact = findContactByChannelExternalChatId(
      params.channelType,
      params.externalChatId,
    );
    if (contact) {
      const ch = contact.channels.find(
        (c) =>
          c.type === params.channelType &&
          c.externalChatId === params.externalChatId,
      );
      if (ch) return { contact, channel: ch };
    }
  }
  return null;
}

/**
 * Repair a channel's identity address, e.g. when a guardian JWT principal no
 * longer matches the stored channel address after a DB reset. Identity-only:
 * the principalId ACL column is gateway-owned.
 *
 * Returns false if the update would violate the unique (type, address)
 * constraint on contact_channels — e.g. when the incoming address already
 * exists on another channel record (a revoked former guardian entry).
 * In that case the repair is skipped and trust stays `unknown`.
 */
export function repairChannelAddress(
  channelId: string,
  newAddress: string,
): boolean {
  const db = getDb();
  const now = Date.now();
  // Look up the channel we're about to update so we know its type.
  const channel = db
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.id, channelId))
    .get();
  if (!channel) return false;

  // Guard: check if another channel row holds this canonical identity.
  const conflicting = findConflictingChannel(db, channel.type, newAddress);

  if (conflicting && conflicting.id !== channelId) {
    return false;
  }

  db.update(contactChannels)
    .set({
      address: newAddress,
      updatedAt: now,
    })
    .where(eq(contactChannels.id, channelId))
    .run();

  notifyContactsChanged();
  return true;
}

// ── Assistant Contact Metadata ──────────────────────────────────────

function parseAssistantMetadata(
  row: typeof assistantContactMetadata.$inferSelect,
): AssistantContactMetadata {
  // Species–metadata pairing is enforced at write time; the cast bridges the
  // runtime DB row into the compile-time discriminated union.
  return {
    contactId: row.contactId,
    species: row.species,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  } as AssistantContactMetadata;
}

export function getAssistantContactMetadata(
  contactId: string,
): AssistantContactMetadata | null {
  const db = getDb();
  const row = db
    .select()
    .from(assistantContactMetadata)
    .where(eq(assistantContactMetadata.contactId, contactId))
    .get();

  if (!row) return null;
  return parseAssistantMetadata(row);
}

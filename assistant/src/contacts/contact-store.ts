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
  ContactRole,
  ContactType,
  ContactWithChannels,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Strip LIKE metacharacters so user input is matched literally.
 * SQLite has no default escape character for LIKE, so we strip rather than escape. */
function escapeLike(value: string): string {
  return value.replace(/%/g, "").replace(/_/g, "");
}

/**
 * Find the first contact_channels row whose (type, address) matches.
 * Uses COLLATE NOCASE to find legacy lowercased rows (pre-migration 290).
 */
function findConflictingChannel(
  db: ReturnType<typeof getDb>,
  type: string,
  address: string,
) {
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
    // gateway-owned; the serve layer stamps the real role from the gateway
    // guardian id set.
    role: "contact",
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

/** @deprecated Use {@link getContact} directly. */
export const getContactInternal = getContact;

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
  role?: ContactRole;
  contactType?: ContactType;
  userFile?: string | null;
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
      return { ...getContactInternal(contactId)!, created: false };
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
        return { ...getContactInternal(contactId)!, created: false };
      }
    }
  }

  // Create new contact
  contactId = contactId ?? uuid();
  const resolvedUserFile =
    params.userFile !== undefined
      ? params.userFile
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
  return { ...getContactInternal(contactId)!, created: true };
}

/**
 * Add new channels to a contact without removing existing ones.
 * When a channel already exists (same type+address), updates access/verification
 * fields if provided. Skips channels owned by a different contact.
 */
function syncChannels(
  contactId: string,
  channels: SyncChannelData[],
  now: number,
  reassignConflicting?: boolean,
): void {
  const db = getDb();

  for (const ch of channels) {
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
        id: uuid(),
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
      const contact = getContactInternal(id);
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
      const contact = getContactInternal(id);
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
      const contact = getContactInternal(id);
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
 * Merge two contacts into one. The surviving contact keeps the
 * more recent interaction timestamp, concatenated notes, and all channels
 * from both contacts. The donor contact is deleted after merging.
 */
export function mergeContacts(
  keepId: string,
  mergeId: string,
): ContactWithChannels {
  const db = getDb();

  if (keepId === mergeId) throw new Error("Cannot merge a contact with itself");

  db.transaction((tx) => {
    const now = Date.now();

    const keep = tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, keepId))
      .get();
    if (!keep) throw new Error(`Contact "${keepId}" not found`);

    const merge = tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, mergeId))
      .get();
    if (!merge) throw new Error(`Contact "${mergeId}" not found`);

    tx.update(contacts)
      .set({
        notes: [keep.notes, merge.notes].filter(Boolean).join("\n") || null,
        updatedAt: now,
      })
      .where(eq(contacts.id, keepId))
      .run();

    // Move channels from donor to survivor, skipping duplicates
    const donorChannels = tx
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.contactId, mergeId))
      .all();

    for (const ch of donorChannels) {
      // COLLATE NOCASE catches legacy lowercased rows so we don't try to
      // move a donor channel that collides with an existing survivor channel.
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
          .set({ contactId: keepId })
          .where(eq(contactChannels.id, ch.id))
          .run();
      }
    }

    // Delete the donor contact (cascading deletes remaining channels)
    tx.delete(contacts).where(eq(contacts.id, mergeId)).run();
  });

  notifyContactsChanged();
  return getContactInternal(keepId)!;
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
  return getContactInternal(channel.contactId);
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
  return getContactInternal(channel.contactId);
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
 * Heal a guardian channel's identity address when the JWT principal no longer
 * matches the stored guardian binding after a DB reset. The principalId ACL
 * column is gateway-owned and no longer written here; only the channel identity
 * address is repaired.
 *
 * Returns false if the update would violate the unique (type, address)
 * constraint on contact_channels — e.g. when the incoming principal already
 * exists on another channel record (a revoked former guardian entry).
 * In that case the heal is skipped and trust stays `unknown`.
 */
export function updateContactPrincipalAndChannel(
  _contactId: string,
  channelId: string,
  newPrincipalId: string,
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
  const conflicting = findConflictingChannel(db, channel.type, newPrincipalId);

  if (conflicting && conflicting.id !== channelId) {
    return false;
  }

  db.update(contactChannels)
    .set({
      address: newPrincipalId,
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

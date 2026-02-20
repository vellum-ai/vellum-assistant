import { and, eq, like, desc, asc } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from '../memory/db.js';
import { contacts, contactChannels } from '../memory/schema.js';
import type { Contact, ContactChannel, ContactWithChannels } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Strip LIKE metacharacters so user input is matched literally.
 * SQLite has no default escape character for LIKE, so we strip rather than escape. */
function escapeLike(value: string): string {
  return value.replace(/%/g, '').replace(/_/g, '');
}

function parseContact(row: typeof contacts.$inferSelect): Contact {
  return {
    id: row.id,
    displayName: row.displayName,
    relationship: row.relationship,
    importance: row.importance,
    responseExpectation: row.responseExpectation,
    preferredTone: row.preferredTone,
    lastInteraction: row.lastInteraction,
    interactionCount: row.interactionCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseChannel(row: typeof contactChannels.$inferSelect): ContactChannel {
  return {
    id: row.id,
    contactId: row.contactId,
    type: row.type,
    address: row.address,
    isPrimary: row.isPrimary,
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
  return { ...contact, channels: getChannelsForContact(contact.id) };
}

// ── CRUD ─────────────────────────────────────────────────────────────

export function getContact(id: string): ContactWithChannels | null {
  const db = getDb();
  const row = db.select().from(contacts).where(eq(contacts.id, id)).get();
  if (!row) return null;
  return withChannels(parseContact(row));
}

export function upsertContact(params: {
  id?: string;
  displayName: string;
  relationship?: string | null;
  importance?: number;
  responseExpectation?: string | null;
  preferredTone?: string | null;
  channels?: Array<{ type: string; address: string; isPrimary?: boolean }>;
}): ContactWithChannels & { created: boolean } {
  const db = getDb();
  const now = Date.now();

  let contactId = params.id;

  // If an ID is provided, check if the contact exists for update
  if (contactId) {
    const existing = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
    if (existing) {
      db.update(contacts)
        .set({
          displayName: params.displayName,
          relationship: params.relationship !== undefined ? params.relationship : existing.relationship,
          importance: params.importance !== undefined ? params.importance : existing.importance,
          responseExpectation: params.responseExpectation !== undefined ? params.responseExpectation : existing.responseExpectation,
          preferredTone: params.preferredTone !== undefined ? params.preferredTone : existing.preferredTone,
          updatedAt: now,
        })
        .where(eq(contacts.id, contactId))
        .run();

      if (params.channels) {
        syncChannels(contactId, params.channels, now);
      }

      return { ...getContact(contactId)!, created: false };
    }
  }

  // Try to find by channel address to avoid duplicates
  if (!contactId && params.channels && params.channels.length > 0) {
    for (const ch of params.channels) {
      const existingChannel = db
        .select()
        .from(contactChannels)
        .where(and(eq(contactChannels.type, ch.type), eq(contactChannels.address, ch.address.toLowerCase())))
        .get();
      if (existingChannel) {
        contactId = existingChannel.contactId;
        // Update existing contact
        db.update(contacts)
          .set({
            displayName: params.displayName,
            relationship: params.relationship !== undefined ? params.relationship : undefined,
            importance: params.importance !== undefined ? params.importance : undefined,
            responseExpectation: params.responseExpectation !== undefined ? params.responseExpectation : undefined,
            preferredTone: params.preferredTone !== undefined ? params.preferredTone : undefined,
            updatedAt: now,
          })
          .where(eq(contacts.id, contactId))
          .run();

        syncChannels(contactId, params.channels, now);
        return { ...getContact(contactId)!, created: false };
      }
    }
  }

  // Create new contact
  contactId = contactId ?? uuid();
  db.insert(contacts).values({
    id: contactId,
    displayName: params.displayName,
    relationship: params.relationship ?? null,
    importance: params.importance ?? 0.5,
    responseExpectation: params.responseExpectation ?? null,
    preferredTone: params.preferredTone ?? null,
    lastInteraction: null,
    interactionCount: 0,
    createdAt: now,
    updatedAt: now,
  }).run();

  if (params.channels) {
    syncChannels(contactId, params.channels, now);
  }

  return { ...getContact(contactId)!, created: true };
}

/**
 * Add new channels to a contact without removing existing ones.
 * Skips channels that already exist (same type+address).
 */
function syncChannels(
  contactId: string,
  channels: Array<{ type: string; address: string; isPrimary?: boolean }>,
  now: number,
): void {
  const db = getDb();

  for (const ch of channels) {
    const normalizedAddress = ch.address.toLowerCase();

    // Check if this channel already exists for this contact
    const existing = db
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.contactId, contactId),
          eq(contactChannels.type, ch.type),
          eq(contactChannels.address, normalizedAddress),
        ),
      )
      .get();

    if (existing) {
      // Update primary flag if specified
      if (ch.isPrimary !== undefined) {
        db.update(contactChannels)
          .set({ isPrimary: ch.isPrimary })
          .where(eq(contactChannels.id, existing.id))
          .run();
      }
      continue;
    }

    // Check if this channel exists for a different contact (unique constraint)
    const conflicting = db
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.type, ch.type),
          eq(contactChannels.address, normalizedAddress),
        ),
      )
      .get();

    if (conflicting) {
      // Channel belongs to another contact -- skip to avoid unique constraint violation.
      // The caller should use contact_merge to combine the two contacts.
      continue;
    }

    db.insert(contactChannels).values({
      id: uuid(),
      contactId,
      type: ch.type,
      address: normalizedAddress,
      isPrimary: ch.isPrimary ?? false,
      createdAt: now,
    }).run();
  }
}

export function searchContacts(params: {
  query?: string;
  channelAddress?: string;
  channelType?: string;
  relationship?: string;
  limit?: number;
}): ContactWithChannels[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(params.limit ?? 20, 100));

  // Search by channel address first (exact or partial match)
  if (params.channelAddress) {
    const normalizedAddress = escapeLike(params.channelAddress.toLowerCase());
    if (!normalizedAddress) return [];
    const channelRows = db
      .select()
      .from(contactChannels)
      .where(
        params.channelType
          ? and(
              eq(contactChannels.type, params.channelType),
              like(contactChannels.address, `%${normalizedAddress}%`),
            )
          : like(contactChannels.address, `%${normalizedAddress}%`),
      )
      .all();

    const contactIds = [...new Set(channelRows.map((r) => r.contactId))];
    if (contactIds.length === 0) return [];

    const results: ContactWithChannels[] = [];
    for (const id of contactIds.slice(0, limit)) {
      const contact = getContact(id);
      if (contact) results.push(contact);
    }
    return results;
  }

  // Search by display name and/or relationship
  const conditions = [];
  if (params.query) {
    const sanitized = escapeLike(params.query);
    if (!sanitized && !params.relationship) return [];
    if (sanitized) {
      conditions.push(like(contacts.displayName, `%${sanitized}%`));
    }
  }
  if (params.relationship) {
    conditions.push(eq(contacts.relationship, params.relationship));
  }

  const whereClause = conditions.length > 0
    ? conditions.length === 1
      ? conditions[0]
      : and(...conditions)
    : undefined;

  const rows = db
    .select()
    .from(contacts)
    .where(whereClause)
    .orderBy(desc(contacts.importance), desc(contacts.lastInteraction))
    .limit(limit)
    .all();

  return rows.map((r) => withChannels(parseContact(r)));
}

export function listContacts(limit = 50): ContactWithChannels[] {
  const db = getDb();
  const rows = db
    .select()
    .from(contacts)
    .orderBy(desc(contacts.importance), desc(contacts.lastInteraction))
    .limit(Math.min(limit, 200))
    .all();
  return rows.map((r) => withChannels(parseContact(r)));
}

/**
 * Merge two contacts into one. The surviving contact keeps the higher importance,
 * more recent interaction timestamp, and all channels from both contacts.
 * The donor contact is deleted after merging.
 */
export function mergeContacts(keepId: string, mergeId: string): ContactWithChannels {
  const db = getDb();

  if (keepId === mergeId) throw new Error('Cannot merge a contact with itself');

  db.transaction((tx) => {
    const now = Date.now();

    const keep = tx.select().from(contacts).where(eq(contacts.id, keepId)).get();
    if (!keep) throw new Error(`Contact "${keepId}" not found`);

    const merge = tx.select().from(contacts).where(eq(contacts.id, mergeId)).get();
    if (!merge) throw new Error(`Contact "${mergeId}" not found`);

    // Resolve merged field values — pick the better/more recent value
    const mergedImportance = Math.max(keep.importance, merge.importance);
    const mergedInteractionCount = keep.interactionCount + merge.interactionCount;
    const mergedLastInteraction = Math.max(keep.lastInteraction ?? 0, merge.lastInteraction ?? 0) || null;

    tx.update(contacts)
      .set({
        importance: mergedImportance,
        interactionCount: mergedInteractionCount,
        lastInteraction: mergedLastInteraction,
        // Prefer keep's values, fall back to merge's
        relationship: keep.relationship ?? merge.relationship,
        responseExpectation: keep.responseExpectation ?? merge.responseExpectation,
        preferredTone: keep.preferredTone ?? merge.preferredTone,
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
      const exists = tx
        .select()
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.contactId, keepId),
            eq(contactChannels.type, ch.type),
            eq(contactChannels.address, ch.address),
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

  return getContact(keepId)!;
}

/**
 * Record an interaction with a contact — bumps count and updates timestamp.
 */
export function recordInteraction(contactId: string): void {
  const db = getDb();
  const now = Date.now();
  const existing = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!existing) return;

  db.update(contacts)
    .set({
      lastInteraction: now,
      interactionCount: existing.interactionCount + 1,
      updatedAt: now,
    })
    .where(eq(contacts.id, contactId))
    .run();
}

/**
 * Find a contact by a specific channel address. Returns null if not found.
 */
export function findContactByAddress(type: string, address: string): ContactWithChannels | null {
  const db = getDb();
  const channel = db
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, type),
        eq(contactChannels.address, address.toLowerCase()),
      ),
    )
    .get();

  if (!channel) return null;
  return getContact(channel.contactId);
}

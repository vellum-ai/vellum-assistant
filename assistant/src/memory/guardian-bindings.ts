/**
 * Guardian binding CRUD operations.
 *
 * A binding records which external user is the designated guardian
 * for a given (assistantId, channel) pair.
 */

import { and, asc, desc, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

import { syncSingleGuardianBinding } from '../contacts/contact-sync.js';
import { revokeGuardianChannel } from '../contacts/contact-store.js';
import { getLogger } from '../util/logger.js';
import { getDb } from './db-connection.js';
import { channelGuardianBindings } from './schema.js';

const log = getLogger('guardian-bindings');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BindingStatus = 'active' | 'revoked';

export interface GuardianBinding {
  id: string;
  assistantId: string;
  channel: string;
  guardianExternalUserId: string;
  guardianDeliveryChatId: string;
  guardianPrincipalId: string;
  status: BindingStatus;
  verifiedAt: number;
  verifiedVia: string;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToBinding(row: typeof channelGuardianBindings.$inferSelect): GuardianBinding {
  return {
    id: row.id,
    assistantId: row.assistantId,
    channel: row.channel,
    guardianExternalUserId: row.guardianExternalUserId,
    guardianDeliveryChatId: row.guardianDeliveryChatId,
    guardianPrincipalId: row.guardianPrincipalId,
    status: row.status as BindingStatus,
    verifiedAt: row.verifiedAt,
    verifiedVia: row.verifiedVia,
    metadataJson: row.metadataJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function createBinding(params: {
  assistantId: string;
  channel: string;
  guardianExternalUserId: string;
  guardianDeliveryChatId: string;
  guardianPrincipalId: string;
  verifiedVia?: string;
  metadataJson?: string | null;
}): GuardianBinding {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  const row = {
    id,
    assistantId: params.assistantId,
    channel: params.channel,
    guardianExternalUserId: params.guardianExternalUserId,
    guardianDeliveryChatId: params.guardianDeliveryChatId,
    guardianPrincipalId: params.guardianPrincipalId,
    status: 'active' as const,
    verifiedAt: now,
    verifiedVia: params.verifiedVia ?? 'challenge',
    metadataJson: params.metadataJson ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(channelGuardianBindings).values(row).run();

  const binding = rowToBinding(row);
  try {
    syncSingleGuardianBinding(binding);
  } catch (err) {
    log.warn({ err }, 'Contact sync failed for guardian binding');
  }

  return binding;
}

export function getActiveBinding(assistantId: string, channel: string): GuardianBinding | null {
  const db = getDb();
  const row = db
    .select()
    .from(channelGuardianBindings)
    .where(
      and(
        eq(channelGuardianBindings.assistantId, assistantId),
        eq(channelGuardianBindings.channel, channel),
        eq(channelGuardianBindings.status, 'active'),
      ),
    )
    .get();

  return row ? rowToBinding(row) : null;
}

/**
 * List all active guardian bindings for an assistant across all channels.
 * Deterministic ordering: verifiedAt DESC (most recently verified first),
 * then channel ASC (alphabetical tiebreaker).
 */
export function listActiveBindingsByAssistant(assistantId: string): GuardianBinding[] {
  const db = getDb();
  return db
    .select()
    .from(channelGuardianBindings)
    .where(
      and(
        eq(channelGuardianBindings.assistantId, assistantId),
        eq(channelGuardianBindings.status, 'active'),
      ),
    )
    .orderBy(
      desc(channelGuardianBindings.verifiedAt),
      asc(channelGuardianBindings.channel),
    )
    .all()
    .map(rowToBinding);
}

export function revokeBinding(assistantId: string, channel: string): boolean {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select({ id: channelGuardianBindings.id })
    .from(channelGuardianBindings)
    .where(
      and(
        eq(channelGuardianBindings.assistantId, assistantId),
        eq(channelGuardianBindings.channel, channel),
        eq(channelGuardianBindings.status, 'active'),
      ),
    )
    .get();

  if (!existing) return false;

  db.update(channelGuardianBindings)
    .set({ status: 'revoked', updatedAt: now })
    .where(eq(channelGuardianBindings.id, existing.id))
    .run();

  // Sync revocation to the contacts table so findGuardianForChannel()
  // no longer returns stale data for revoked bindings.
  try {
    revokeGuardianChannel(channel);
  } catch (err) {
    log.warn({ err }, 'Failed to revoke contact channel for guardian binding');
  }

  return true;
}

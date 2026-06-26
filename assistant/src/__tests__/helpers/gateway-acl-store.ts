/**
 * In-process stand-in for the gateway ACL DB (`gwContacts`/`gwContactChannels`),
 * used by the trust/guardian test helpers.
 *
 * Production resolves the guardian binding + per-channel trust from the GATEWAY
 * DB (see `gateway/src/risk/guardian-delivery-resolver.ts`). The gateway package
 * is not a dependency of the assistant, so its `getGatewayDb()` can't be imported
 * here; instead this module mirrors the gateway ACL rows the resolver reads
 * (`role`, `status`, `verifiedAt`, delivery endpoints). The test seed helpers
 * write here and the test guardian-delivery resolver reads here, so NO test code
 * touches the assistant DB's ACL columns (which Phase B drops).
 *
 * Isolation: rows are keyed by the assistant channel id (which the identity
 * upsert regenerates per test). Reads drop any row whose backing assistant
 * identity channel no longer exists, so a `DELETE FROM contact_channels` /
 * `resetDbForTesting()` in a test's `beforeEach` automatically evicts stale
 * gateway rows without each test having to reset this store.
 */

import { eq } from "drizzle-orm";

import { getDb } from "../../memory/db-connection.js";
import { contactChannels } from "../../memory/schema.js";

export interface GatewayAclRow {
  contactId: string;
  channelId: string;
  channelType: string;
  address: string;
  externalChatId: string | null;
  principalId: string | null;
  displayName: string | null;
  /** Guardian iff role === "guardian"; mirrors gwContacts.role. */
  role: string;
  /** Mirrors gwContactChannels.status. */
  status: string;
  verifiedAt: number | null;
}

const rows = new Map<string, GatewayAclRow>();

/** Upsert a gateway ACL row for a channel (keyed by assistant channel id). */
export function upsertGatewayAcl(row: GatewayAclRow): void {
  rows.set(row.channelId, row);
}

/** Patch the status of an existing gateway ACL row, if present. */
export function setGatewayAclStatusByChannelId(
  channelId: string,
  status: string,
): void {
  const existing = rows.get(channelId);
  if (existing) existing.status = status;
}

/** Patch the status of every gateway ACL row of a channel type. */
export function setGatewayAclStatusByType(
  channelType: string,
  status: string,
): void {
  for (const row of rows.values()) {
    if (row.channelType === channelType) row.status = status;
  }
}

/**
 * Live gateway ACL rows: those whose backing assistant identity channel still
 * exists. Stale rows (left over from a prior test whose tables were reset) are
 * dropped, giving automatic per-test isolation.
 */
export function liveGatewayAclRows(): GatewayAclRow[] {
  const db = getDb();
  const live: GatewayAclRow[] = [];
  for (const row of rows.values()) {
    const exists = db
      .select({ id: contactChannels.id })
      .from(contactChannels)
      .where(eq(contactChannels.id, row.channelId))
      .get();
    if (exists) live.push(row);
    else rows.delete(row.channelId);
  }
  return live;
}

/** Test-only: clear the entire gateway ACL store. */
export function __resetGatewayAclStoreForTest(): void {
  rows.clear();
}

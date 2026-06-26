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
 * touches the assistant DB's ACL columns — those columns are gateway-owned.
 *
 * Purely in-memory: no assistant DB / `src/` reach. Per-test isolation comes
 * from the shared DB reset: `resetDbForTesting()` (db-test-helpers.ts) calls
 * {@link resetGatewayAclStore}, so every test that resets the DB also clears
 * this store. Tests that don't go through that reset call it directly.
 */

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
  /** Mirrors gwContactChannels.policy (allow/deny). */
  policy: string;
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

/** All gateway ACL rows currently in the store. */
export function gatewayAclRows(): GatewayAclRow[] {
  return [...rows.values()];
}

/** The gateway ACL row for a channel id, or `undefined` when absent. */
export function gatewayAclByChannelId(
  channelId: string,
): GatewayAclRow | undefined {
  return rows.get(channelId);
}

/**
 * Clear the gateway ACL store. Invoked by `resetDbForTesting()` so the shared DB
 * reset gives every seeding test per-test isolation; tests that don't go through
 * that reset call this directly in `beforeEach`.
 */
export function resetGatewayAclStore(): void {
  rows.clear();
}

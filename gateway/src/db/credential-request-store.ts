/**
 * Data-access layer for `credential_requests` — one-time credential-collection
 * links. The gateway is the source of truth for link/token state; credential
 * VALUES never touch this store (they are forwarded to the daemon in memory
 * only at submit time).
 *
 * Lifecycle: active → redeeming (claimed while the value is forwarded to the
 * daemon) → redeemed, with redeeming → active on forward failure so a
 * transient daemon error does not burn the link. Claims are status-gated
 * `UPDATE … RETURNING` so only the first of two racing submitters wins.
 */

import { and, eq, gt, sql } from "drizzle-orm";

import { type GatewayDb, getGatewayDb } from "./connection.js";
import { credentialRequests } from "./schema.js";

export type CredentialRequestRow = typeof credentialRequests.$inferSelect;

export type CredentialRequestPurpose = "standalone" | "prompt";

/** Cap on simultaneously active links — bounds abuse and table growth. */
export const MAX_ACTIVE_CREDENTIAL_REQUESTS = 200;

export class CredentialRequestStore {
  private injectedDb?: GatewayDb;

  constructor(db?: GatewayDb) {
    this.injectedDb = db;
  }

  private get db(): GatewayDb {
    return this.injectedDb ?? getGatewayDb();
  }

  create(params: {
    id: string;
    tokenHash: string;
    purpose: CredentialRequestPurpose;
    service: string;
    field: string;
    label?: string | null;
    secretPromptId?: string | null;
    policyJson?: string | null;
    expiresAt: number;
  }): CredentialRequestRow {
    const now = Date.now();
    return this.db
      .insert(credentialRequests)
      .values({
        id: params.id,
        tokenHash: params.tokenHash,
        purpose: params.purpose,
        service: params.service,
        field: params.field,
        label: params.label ?? null,
        secretPromptId: params.secretPromptId ?? null,
        policyJson: params.policyJson ?? null,
        maxUses: 1,
        useCount: 0,
        expiresAt: params.expiresAt,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  findByTokenHash(tokenHash: string): CredentialRequestRow | null {
    return (
      this.db
        .select()
        .from(credentialRequests)
        .where(eq(credentialRequests.tokenHash, tokenHash))
        .get() ?? null
    );
  }

  /** Number of unexpired active links (input to the creation cap). */
  countActive(now: number = Date.now()): number {
    const rows = this.db
      .select({ id: credentialRequests.id })
      .from(credentialRequests)
      .where(
        and(
          eq(credentialRequests.status, "active"),
          gt(credentialRequests.expiresAt, now),
        ),
      )
      .all();
    return rows.length;
  }

  /**
   * Atomically claim an active, unexpired link for submission. Only the first
   * of two racing submitters gets `claimed: true`; the loser sees the row in
   * "redeeming"/"redeemed" state.
   */
  claimForSubmission(id: string, now: number = Date.now()): boolean {
    const updated = this.db
      .update(credentialRequests)
      .set({ status: "redeeming", updatedAt: now })
      .where(
        and(
          eq(credentialRequests.id, id),
          eq(credentialRequests.status, "active"),
          gt(credentialRequests.expiresAt, now),
        ),
      )
      .returning({ id: credentialRequests.id })
      .all();
    return updated.length > 0;
  }

  /** Complete a claimed submission: bump useCount, stamp redeemedAt, flip to redeemed. */
  completeRedemption(id: string): void {
    const now = Date.now();
    this.db
      .update(credentialRequests)
      .set({
        status: "redeemed",
        useCount: sql`${credentialRequests.useCount} + 1`,
        redeemedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(credentialRequests.id, id),
          eq(credentialRequests.status, "redeeming"),
        ),
      )
      .run();
  }

  /** Release a claim after a transient forward failure so the link stays usable. */
  releaseClaim(id: string): void {
    this.db
      .update(credentialRequests)
      .set({ status: "active", updatedAt: Date.now() })
      .where(
        and(
          eq(credentialRequests.id, id),
          eq(credentialRequests.status, "redeeming"),
        ),
      )
      .run();
  }
}

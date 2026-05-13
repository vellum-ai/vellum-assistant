/**
 * Gateway-side invite store.
 *
 * The gateway's `ingress_invites` table is a **mirror** of the daemon's
 * `assistant_ingress_invites` table during the gateway-security-migration
 * Track B handoff. Today's writers:
 *
 *   - Daemon `createInvite()` → IPC `mirror_invite_create` → this store
 *
 * Once redemption goes gateway-native (Track B PR-B-2) this store will also
 * own use-count bumps and status flips, and will dual-write back to the
 * daemon (matching Track A's pattern).
 *
 * Failure policy: every write is best-effort from the caller's perspective.
 * This store throws on DB errors; the IPC handler logs and continues so the
 * daemon-side caller can ignore mirror failures without rolling back the
 * authoritative write.
 */

import { eq } from "drizzle-orm";

import { type GatewayDb, getGatewayDb } from "./connection.js";
import { ingressInvites } from "./schema.js";

export type IngressInvite = typeof ingressInvites.$inferSelect;

export class InviteStore {
  private injectedDb?: GatewayDb;

  constructor(db?: GatewayDb) {
    this.injectedDb = db;
  }

  private get db(): GatewayDb {
    return this.injectedDb ?? getGatewayDb();
  }

  /**
   * Insert (or replace) a mirror row for an invite that was just created
   * authoritatively on the daemon. Idempotent on `id` so a daemon retry
   * after a transient gateway failure converges to the right state.
   */
  mirrorCreate(invite: typeof ingressInvites.$inferInsert): IngressInvite {
    const existing = this.db
      .select()
      .from(ingressInvites)
      .where(eq(ingressInvites.id, invite.id))
      .get();

    if (existing) {
      this.db
        .update(ingressInvites)
        .set({
          sourceChannel: invite.sourceChannel,
          tokenHash: invite.tokenHash,
          sourceConversationId: invite.sourceConversationId ?? null,
          note: invite.note ?? null,
          maxUses: invite.maxUses ?? 1,
          useCount: invite.useCount ?? 0,
          expiresAt: invite.expiresAt,
          status: invite.status ?? "active",
          redeemedByExternalUserId: invite.redeemedByExternalUserId ?? null,
          redeemedByExternalChatId: invite.redeemedByExternalChatId ?? null,
          redeemedAt: invite.redeemedAt ?? null,
          expectedExternalUserId: invite.expectedExternalUserId ?? null,
          voiceCodeHash: invite.voiceCodeHash ?? null,
          voiceCodeDigits: invite.voiceCodeDigits ?? null,
          inviteCodeHash: invite.inviteCodeHash ?? null,
          friendName: invite.friendName ?? null,
          guardianName: invite.guardianName ?? null,
          contactId: invite.contactId,
          updatedAt: invite.updatedAt,
        })
        .where(eq(ingressInvites.id, invite.id))
        .run();
    } else {
      this.db.insert(ingressInvites).values(invite).run();
    }

    return this.db
      .select()
      .from(ingressInvites)
      .where(eq(ingressInvites.id, invite.id))
      .get()!;
  }

  getInvite(id: string): IngressInvite | undefined {
    return this.db
      .select()
      .from(ingressInvites)
      .where(eq(ingressInvites.id, id))
      .get();
  }
}

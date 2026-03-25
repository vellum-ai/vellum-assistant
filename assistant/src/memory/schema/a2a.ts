import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Tracks A2A pairing requests for the invite-code-gated handshake.
 *
 * `direction` discriminates the role this assistant played:
 *   - "outbound" — we initiated the pairing; remoteAssistantId/remoteGatewayUrl
 *     identifies the target.
 *   - "inbound" — they contacted us; remoteAssistantId/remoteGatewayUrl
 *     identifies the sender.
 */
export const a2aPairingRequests = sqliteTable(
  "a2a_pairing_requests",
  {
    id: text("id").primaryKey(),
    direction: text("direction").notNull(), // "outbound" | "inbound"
    inviteCode: text("invite_code").notNull(),
    remoteAssistantId: text("remote_assistant_id").notNull(),
    remoteGatewayUrl: text("remote_gateway_url").notNull(),
    status: text("status").notNull(), // "pending" | "verification_pending" | "accepted" | "expired" | "failed"
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [uniqueIndex("idx_a2a_pairing_invite_code").on(table.inviteCode)],
);

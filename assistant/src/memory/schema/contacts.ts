import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { conversations } from "./conversations.js";

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  role: text("role").notNull().default("contact"), // 'guardian' | 'contact'
  principalId: text("principal_id"), // internal auth principal (nullable)
  contactType: text("contact_type").notNull().default("human"), // 'human' | 'assistant'
});

export const contactChannels = sqliteTable(
  "contact_channels",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // 'email', 'slack', 'whatsapp', 'phone', etc.
    address: text("address").notNull(), // the actual identifier on that channel
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    externalUserId: text("external_user_id"), // channel-native user ID (e.g., Telegram numeric ID, E.164 phone)
    externalChatId: text("external_chat_id"), // delivery/notification routing address (e.g., Telegram chat ID)
    status: text("status").notNull().default("unverified"), // 'active' | 'pending' | 'revoked' | 'blocked' | 'unverified'
    policy: text("policy").notNull().default("allow"), // 'allow' | 'deny' | 'escalate'
    verifiedAt: integer("verified_at"), // epoch ms
    verifiedVia: text("verified_via"), // 'challenge' | 'invite' | 'bootstrap' | etc.
    inviteId: text("invite_id"), // reference to invite that onboarded
    revokedReason: text("revoked_reason"),
    blockedReason: text("blocked_reason"),
    lastSeenAt: integer("last_seen_at"), // epoch ms
    interactionCount: integer("interaction_count").notNull().default(0),
    lastInteraction: integer("last_interaction"),
    updatedAt: integer("updated_at"), // epoch ms
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_contact_channels_type_ext_user").on(
      table.type,
      table.externalUserId,
    ),
    index("idx_contact_channels_type_ext_chat").on(
      table.type,
      table.externalChatId,
    ),
  ],
);

export const assistantContactMetadata = sqliteTable(
  "assistant_contact_metadata",
  {
    contactId: text("contact_id")
      .primaryKey()
      .references(() => contacts.id, { onDelete: "cascade" }),
    species: text("species").notNull(), // 'vellum' | 'openclaw'
    metadata: text("metadata"), // JSON blob for species-specific fields
  },
);

export const assistantIngressInvites = sqliteTable(
  "assistant_ingress_invites",
  {
    id: text("id").primaryKey(),
    sourceChannel: text("source_channel").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBySessionId: text("created_by_session_id"),
    note: text("note"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    status: text("status").notNull().default("active"),
    redeemedByExternalUserId: text("redeemed_by_external_user_id"),
    redeemedByExternalChatId: text("redeemed_by_external_chat_id"),
    redeemedAt: integer("redeemed_at"),
    // Voice invite fields (nullable — non-voice invites leave these NULL)
    expectedExternalUserId: text("expected_external_user_id"),
    voiceCodeHash: text("voice_code_hash"),
    voiceCodeDigits: integer("voice_code_digits"),
    // 6-digit invite code hash (nullable — voice invites use voiceCodeHash instead)
    inviteCodeHash: text("invite_code_hash"),
    // Display metadata for personalized voice prompts (nullable — non-voice invites leave these NULL)
    friendName: text("friend_name"),
    guardianName: text("guardian_name"),
    contactId: text("contact_id").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

export const assistantInboxConversationState = sqliteTable(
  "assistant_inbox_conversation_state",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceChannel: text("source_channel").notNull(),
    externalChatId: text("external_chat_id").notNull(),
    externalUserId: text("external_user_id"),
    displayName: text("display_name"),
    username: text("username"),
    lastInboundAt: integer("last_inbound_at"),
    lastOutboundAt: integer("last_outbound_at"),
    lastMessageAt: integer("last_message_at"),
    unreadCount: integer("unread_count").notNull().default(0),
    pendingEscalationCount: integer("pending_escalation_count")
      .notNull()
      .default(0),
    hasPendingEscalation: integer("has_pending_escalation")
      .notNull()
      .default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

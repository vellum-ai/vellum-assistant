import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { conversations } from "./conversations.js";

export const callSessions = sqliteTable(
  "call_sessions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerCallSid: text("provider_call_sid"),
    fromNumber: text("from_number").notNull(),
    toNumber: text("to_number").notNull(),
    task: text("task"),
    status: text("status").notNull().default("initiated"),
    callMode: text("call_mode"),
    verificationSessionId: text("verification_session_id"),
    inviteFriendName: text("invite_friend_name"),
    inviteGuardianName: text("invite_guardian_name"),
    callerIdentityMode: text("caller_identity_mode"),
    callerIdentitySource: text("caller_identity_source"),
    initiatedFromConversationId: text("initiated_from_conversation_id"),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_call_sessions_status").on(table.status)],
);

export const callEvents = sqliteTable("call_events", {
  id: text("id").primaryKey(),
  callSessionId: text("call_session_id")
    .notNull()
    .references(() => callSessions.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const callPendingQuestions = sqliteTable("call_pending_questions", {
  id: text("id").primaryKey(),
  callSessionId: text("call_session_id")
    .notNull()
    .references(() => callSessions.id, { onDelete: "cascade" }),
  questionText: text("question_text").notNull(),
  status: text("status").notNull().default("pending"),
  askedAt: integer("asked_at").notNull(),
  answeredAt: integer("answered_at"),
  answerText: text("answer_text"),
});

export const processedCallbacks = sqliteTable("processed_callbacks", {
  id: text("id").primaryKey(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  callSessionId: text("call_session_id")
    .notNull()
    .references(() => callSessions.id, { onDelete: "cascade" }),
  claimId: text("claim_id"),
  createdAt: integer("created_at").notNull(),
});

export const externalConversationBindings = sqliteTable(
  "external_conversation_bindings",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceChannel: text("source_channel").notNull(),
    externalChatId: text("external_chat_id").notNull(),
    externalUserId: text("external_user_id"),
    displayName: text("display_name"),
    username: text("username"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastInboundAt: integer("last_inbound_at"),
    lastOutboundAt: integer("last_outbound_at"),
  },
);

export const channelVerificationSessions = sqliteTable(
  "channel_verification_sessions",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    challengeHash: text("challenge_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    status: text("status").notNull().default("pending"),
    createdByConversationId: text("created_by_session_id"),
    consumedByExternalUserId: text("consumed_by_external_user_id"),
    consumedByChatId: text("consumed_by_chat_id"),
    // Outbound session: expected-identity binding
    expectedExternalUserId: text("expected_external_user_id"),
    expectedChatId: text("expected_chat_id"),
    expectedPhoneE164: text("expected_phone_e164"),
    identityBindingStatus: text("identity_binding_status").default("bound"),
    // Outbound session: delivery tracking
    destinationAddress: text("destination_address"),
    lastSentAt: integer("last_sent_at"),
    sendCount: integer("send_count").default(0),
    nextResendAt: integer("next_resend_at"),
    // Session configuration
    codeDigits: integer("code_digits").default(6),
    maxAttempts: integer("max_attempts").default(3),
    // Distinguishes guardian verification from trusted contact verification
    verificationPurpose: text("verification_purpose").default("guardian"),
    // Telegram bootstrap deep-link token hash
    bootstrapTokenHash: text("bootstrap_token_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

export const channelGuardianApprovalRequests = sqliteTable(
  "channel_guardian_approval_requests",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    requestId: text("request_id"),
    conversationId: text("conversation_id").notNull(),
    channel: text("channel").notNull(),
    requesterExternalUserId: text("requester_external_user_id").notNull(),
    requesterChatId: text("requester_chat_id").notNull(),
    guardianExternalUserId: text("guardian_external_user_id").notNull(),
    guardianChatId: text("guardian_chat_id").notNull(),
    toolName: text("tool_name").notNull(),
    riskLevel: text("risk_level"),
    reason: text("reason"),
    status: text("status").notNull().default("pending"),
    decidedByExternalUserId: text("decided_by_external_user_id"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

export const channelGuardianRateLimits = sqliteTable(
  "channel_guardian_rate_limits",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    actorExternalUserId: text("actor_external_user_id").notNull(),
    actorChatId: text("actor_chat_id").notNull(),
    attemptTimestampsJson: text("attempt_timestamps_json")
      .notNull()
      .default("[]"),
    lockedUntil: integer("locked_until"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

export const mediaAssets = sqliteTable("media_assets", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  filePath: text("file_path").notNull(),
  mimeType: text("mime_type").notNull(),
  durationSeconds: real("duration_seconds"),
  fileHash: text("file_hash").notNull(),
  status: text("status").notNull().default("registered"), // registered | processing | indexed | failed
  mediaType: text("media_type").notNull(), // video | audio | image
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const processingStages = sqliteTable("processing_stages", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  status: text("status").notNull().default("pending"), // pending | running | completed | failed
  progress: integer("progress").notNull().default(0), // 0-100
  lastError: text("last_error"),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
});

export const mediaKeyframes = sqliteTable("media_keyframes", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  timestamp: real("timestamp").notNull(),
  filePath: text("file_path").notNull(),
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at").notNull(),
});

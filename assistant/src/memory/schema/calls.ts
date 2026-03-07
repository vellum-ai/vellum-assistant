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
    guardianVerificationSessionId: text("guardian_verification_session_id"),
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
    createdBySessionId: text("created_by_session_id"),
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
    // Legacy columns kept with defaults for backward compatibility with upgraded databases
    // that still have the old NOT NULL columns without DEFAULT. Not read by app logic.
    invalidAttempts: integer("invalid_attempts").notNull().default(0),
    windowStartedAt: integer("window_started_at").notNull().default(0),
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

export const mediaVisionOutputs = sqliteTable("media_vision_outputs", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  keyframeId: text("keyframe_id")
    .notNull()
    .references(() => mediaKeyframes.id, { onDelete: "cascade" }),
  analysisType: text("analysis_type").notNull(),
  output: text("output").notNull(), // JSON
  confidence: real("confidence"),
  createdAt: integer("created_at").notNull(),
});

export const mediaTimelines = sqliteTable("media_timelines", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  startTime: real("start_time").notNull(),
  endTime: real("end_time").notNull(),
  segmentType: text("segment_type").notNull(),
  attributes: text("attributes"), // JSON
  confidence: real("confidence"),
  createdAt: integer("created_at").notNull(),
});

export const mediaEvents = sqliteTable("media_events", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  startTime: real("start_time").notNull(),
  endTime: real("end_time").notNull(),
  confidence: real("confidence").notNull(),
  reasons: text("reasons").notNull(), // JSON array
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at").notNull(),
});

export const mediaTrackingProfiles = sqliteTable("media_tracking_profiles", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  capabilities: text("capabilities").notNull(), // JSON: { [capName]: { enabled, tier } }
  createdAt: integer("created_at").notNull(),
});

export const mediaEventFeedback = sqliteTable("media_event_feedback", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  eventId: text("event_id")
    .notNull()
    .references(() => mediaEvents.id, { onDelete: "cascade" }),
  feedbackType: text("feedback_type").notNull(), // correct | incorrect | boundary_edit | missed
  originalStartTime: real("original_start_time"),
  originalEndTime: real("original_end_time"),
  correctedStartTime: real("corrected_start_time"),
  correctedEndTime: real("corrected_end_time"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
});

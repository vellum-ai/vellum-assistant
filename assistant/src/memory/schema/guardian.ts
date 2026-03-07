import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { callPendingQuestions, callSessions } from "./calls.js";

export const guardianActionRequests = sqliteTable(
  "guardian_action_requests",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // 'ask_guardian'
    sourceChannel: text("source_channel").notNull(), // 'phone'
    sourceConversationId: text("source_conversation_id").notNull(),
    callSessionId: text("call_session_id")
      .notNull()
      .references(() => callSessions.id, { onDelete: "cascade" }),
    pendingQuestionId: text("pending_question_id")
      .notNull()
      .references(() => callPendingQuestions.id, { onDelete: "cascade" }),
    questionText: text("question_text").notNull(),
    requestCode: text("request_code").notNull(), // short human-readable code for routing replies
    status: text("status").notNull().default("pending"), // pending | answered | expired | cancelled
    answerText: text("answer_text"),
    answeredByChannel: text("answered_by_channel"),
    answeredByExternalUserId: text("answered_by_external_user_id"),
    answeredAt: integer("answered_at"),
    expiresAt: integer("expires_at").notNull(),
    expiredReason: text("expired_reason"), // call_timeout | sweep_timeout | cancelled
    followupState: text("followup_state").notNull().default("none"), // none | awaiting_guardian_choice | dispatching | completed | declined | failed
    lateAnswerText: text("late_answer_text"),
    lateAnsweredAt: integer("late_answered_at"),
    followupAction: text("followup_action"), // call_back | message_back | decline
    followupCompletedAt: integer("followup_completed_at"),
    toolName: text("tool_name"), // tool identity for tool-approval requests
    inputDigest: text("input_digest"), // canonical SHA-256 digest of tool input
    supersededByRequestId: text("superseded_by_request_id"), // links to the request that replaced this one
    supersededAt: integer("superseded_at"), // epoch ms when supersession occurred
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_guardian_action_requests_session_status_created").on(
      table.callSessionId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const guardianActionDeliveries = sqliteTable(
  "guardian_action_deliveries",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => guardianActionRequests.id, { onDelete: "cascade" }),
    destinationChannel: text("destination_channel").notNull(), // 'telegram' | 'vellum'
    destinationConversationId: text("destination_conversation_id"),
    destinationChatId: text("destination_chat_id"),
    destinationExternalUserId: text("destination_external_user_id"),
    status: text("status").notNull().default("pending"), // pending | sent | failed | answered | expired | cancelled
    sentAt: integer("sent_at"),
    respondedAt: integer("responded_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_guardian_action_deliveries_dest_conversation").on(
      table.destinationConversationId,
    ),
  ],
);

export const canonicalGuardianRequests = sqliteTable(
  "canonical_guardian_requests",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    sourceType: text("source_type").notNull(),
    sourceChannel: text("source_channel"),
    conversationId: text("conversation_id"),
    requesterExternalUserId: text("requester_external_user_id"),
    requesterChatId: text("requester_chat_id"),
    guardianExternalUserId: text("guardian_external_user_id"),
    guardianPrincipalId: text("guardian_principal_id"),
    callSessionId: text("call_session_id"),
    pendingQuestionId: text("pending_question_id"),
    questionText: text("question_text"),
    requestCode: text("request_code"),
    toolName: text("tool_name"),
    inputDigest: text("input_digest"),
    status: text("status").notNull().default("pending"),
    answerText: text("answer_text"),
    decidedByExternalUserId: text("decided_by_external_user_id"),
    decidedByPrincipalId: text("decided_by_principal_id"),
    followupState: text("followup_state"),
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_canonical_guardian_requests_status").on(table.status),
    index("idx_canonical_guardian_requests_guardian").on(
      table.guardianExternalUserId,
      table.status,
    ),
    index("idx_canonical_guardian_requests_conversation").on(
      table.conversationId,
      table.status,
    ),
    index("idx_canonical_guardian_requests_source").on(
      table.sourceType,
      table.status,
    ),
    index("idx_canonical_guardian_requests_kind").on(table.kind, table.status),
    index("idx_canonical_guardian_requests_request_code").on(table.requestCode),
  ],
);

export const canonicalGuardianDeliveries = sqliteTable(
  "canonical_guardian_deliveries",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => canonicalGuardianRequests.id, { onDelete: "cascade" }),
    destinationChannel: text("destination_channel").notNull(),
    destinationConversationId: text("destination_conversation_id"),
    destinationChatId: text("destination_chat_id"),
    destinationMessageId: text("destination_message_id"),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_canonical_guardian_deliveries_request_id").on(table.requestId),
    index("idx_canonical_guardian_deliveries_status").on(table.status),
  ],
);

export const scopedApprovalGrants = sqliteTable(
  "scoped_approval_grants",
  {
    id: text("id").primaryKey(),
    scopeMode: text("scope_mode").notNull(), // 'request_id' | 'tool_signature'
    requestId: text("request_id"),
    toolName: text("tool_name"),
    inputDigest: text("input_digest"),
    requestChannel: text("request_channel").notNull(),
    decisionChannel: text("decision_channel").notNull(),
    executionChannel: text("execution_channel"), // null = any channel
    conversationId: text("conversation_id"),
    callSessionId: text("call_session_id"),
    requesterExternalUserId: text("requester_external_user_id"),
    guardianExternalUserId: text("guardian_external_user_id"),
    status: text("status").notNull(), // 'active' | 'consumed' | 'expired' | 'revoked'
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    consumedByRequestId: text("consumed_by_request_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_scoped_grants_request_id").on(table.requestId),
    index("idx_scoped_grants_tool_sig").on(table.toolName, table.inputDigest),
    index("idx_scoped_grants_status_expires").on(table.status, table.expiresAt),
  ],
);

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    consumedByRequestId: text("consumed_by_request_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_scoped_grants_request_id").on(table.requestId),
    index("idx_scoped_grants_tool_sig").on(table.toolName, table.inputDigest),
    index("idx_scoped_grants_status_expires").on(table.status, table.expiresAt),
  ],
);

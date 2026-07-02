import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    scriptSource: text("script_source").notNull(),
    scriptHash: text("script_hash").notNull(),
    argsJson: text("args_json"),
    capabilitiesJson: text("capabilities_json"),
    status: text("status").notNull(),
    conversationId: text("conversation_id"),
    agentsSpawned: integer("agents_spawned").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    resultJson: text("result_json"),
    error: text("error"),
    createdAt: integer("created_at"),
    updatedAt: integer("updated_at"),
    finishedAt: integer("finished_at"),
    trustJson: text("trust_json"),
  },
  (table) => [
    index("idx_workflow_runs_status_created_at").on(
      table.status,
      table.createdAt,
    ),
  ],
);

// Append-only journal of each workflow's agent() calls, keyed by run + sequence
// for crash-recovery replay.
export const workflowJournal = sqliteTable(
  "workflow_journal",
  {
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    callHash: text("call_hash").notNull(),
    kind: text("kind").notNull(),
    requestJson: text("request_json"),
    resultJson: text("result_json"),
    status: text("status").notNull(),
    createdAt: integer("created_at"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
  },
  (table) => [primaryKey({ columns: [table.runId, table.seq] })],
);

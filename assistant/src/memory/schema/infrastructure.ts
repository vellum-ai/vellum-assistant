import {
  blob,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const reminders = sqliteTable("reminders", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  message: text("message").notNull(),
  fireAt: integer("fire_at").notNull(), // epoch ms, absolute timestamp
  mode: text("mode").notNull(), // 'notify' | 'execute'
  status: text("status").notNull(), // 'pending' | 'firing' | 'fired' | 'cancelled'
  firedAt: integer("fired_at"),
  conversationId: text("conversation_id"),
  routingIntent: text("routing_intent").notNull().default("all_channels"), // 'single_channel' | 'multi_channel' | 'all_channels'
  routingHintsJson: text("routing_hints_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const cronJobs = sqliteTable("cron_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  cronExpression: text("cron_expression"), // nullable for one-shot schedules; e.g. '0 9 * * 1-5'
  scheduleSyntax: text("schedule_syntax").notNull().default("cron"), // 'cron' | 'rrule'
  timezone: text("timezone"), // e.g. 'America/Los_Angeles'
  message: text("message").notNull(),
  nextRunAt: integer("next_run_at").notNull(),
  lastRunAt: integer("last_run_at"),
  lastStatus: text("last_status"), // 'ok' | 'error'
  retryCount: integer("retry_count").notNull().default(0),
  createdBy: text("created_by").notNull(), // 'agent' | 'user'
  mode: text("mode").notNull().default("execute"), // 'notify' | 'execute'
  routingIntent: text("routing_intent").notNull().default("all_channels"), // 'single_channel' | 'multi_channel' | 'all_channels'
  routingHintsJson: text("routing_hints_json").notNull().default("{}"),
  status: text("status").notNull().default("active"), // 'active' | 'firing' | 'fired' | 'cancelled'
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const cronRuns = sqliteTable("cron_runs", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => cronJobs.id, { onDelete: "cascade" }),
  status: text("status").notNull(), // 'ok' | 'error'
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  durationMs: integer("duration_ms"),
  output: text("output"),
  error: text("error"),
  conversationId: text("conversation_id"),
  createdAt: integer("created_at").notNull(),
});

// Recurrence-centric aliases — prefer these in new code.
// Physical table names remain `cron_jobs` / `cron_runs` for migration compatibility.
export const scheduleJobs = cronJobs;
export const scheduleRuns = cronRuns;

export const sharedAppLinks = sqliteTable("shared_app_links", {
  id: text("id").primaryKey(),
  shareToken: text("share_token").notNull().unique(),
  bundleData: blob("bundle_data", { mode: "buffer" }).notNull(),
  bundleSizeBytes: integer("bundle_size_bytes").notNull(),
  manifestJson: text("manifest_json").notNull(),
  downloadCount: integer("download_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"),
});

export const publishedPages = sqliteTable("published_pages", {
  id: text("id").primaryKey(),
  deploymentId: text("deployment_id").notNull().unique(),
  publicUrl: text("public_url").notNull(),
  pageTitle: text("page_title"),
  htmlHash: text("html_hash").notNull(),
  publishedAt: integer("published_at").notNull(),
  status: text("status").notNull().default("active"),
  appId: text("app_id"),
  projectSlug: text("project_slug"),
});

export const watchers = sqliteTable("watchers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  providerId: text("provider_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  pollIntervalMs: integer("poll_interval_ms").notNull().default(60000),
  actionPrompt: text("action_prompt").notNull(),
  watermark: text("watermark"),
  conversationId: text("conversation_id"),
  status: text("status").notNull().default("idle"), // idle | polling | error | disabled
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  lastError: text("last_error"),
  lastPollAt: integer("last_poll_at"),
  nextPollAt: integer("next_poll_at").notNull(),
  configJson: text("config_json"),
  credentialService: text("credential_service").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const watcherEvents = sqliteTable("watcher_events", {
  id: text("id").primaryKey(),
  watcherId: text("watcher_id")
    .notNull()
    .references(() => watchers.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  eventType: text("event_type").notNull(),
  summary: text("summary").notNull(),
  payloadJson: text("payload_json").notNull(),
  disposition: text("disposition").notNull().default("pending"), // pending | silent | notify | escalate | error
  llmAction: text("llm_action"),
  processedAt: integer("processed_at"),
  createdAt: integer("created_at").notNull(),
});

export const llmRequestLogs = sqliteTable("llm_request_logs", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  requestPayload: text("request_payload").notNull(),
  responsePayload: text("response_payload").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const llmUsageEvents = sqliteTable(
  "llm_usage_events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    conversationId: text("conversation_id"),
    runId: text("run_id"),
    requestId: text("request_id"),
    actor: text("actor").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    estimatedCostUsd: real("estimated_cost_usd"),
    pricingStatus: text("pricing_status").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => [
    index("idx_llm_usage_events_conversation_id").on(table.conversationId),
  ],
);

export const actorTokenRecords = sqliteTable("actor_token_records", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  guardianPrincipalId: text("guardian_principal_id").notNull(),
  hashedDeviceId: text("hashed_device_id").notNull(),
  platform: text("platform").notNull(),
  status: text("status").notNull().default("active"),
  issuedAt: integer("issued_at").notNull(),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const actorRefreshTokenRecords = sqliteTable(
  "actor_refresh_token_records",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    familyId: text("family_id").notNull(),
    guardianPrincipalId: text("guardian_principal_id").notNull(),
    hashedDeviceId: text("hashed_device_id").notNull(),
    platform: text("platform").notNull(),
    status: text("status").notNull().default("active"),
    issuedAt: integer("issued_at").notNull(),
    absoluteExpiresAt: integer("absolute_expires_at").notNull(),
    inactivityExpiresAt: integer("inactivity_expires_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

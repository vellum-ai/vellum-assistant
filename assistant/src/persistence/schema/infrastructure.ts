import {
  blob,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const cronJobs = sqliteTable("cron_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  cronExpression: text("cron_expression"), // nullable for one-shot schedules; e.g. '0 9 * * 1-5'
  scheduleSyntax: text("schedule_syntax").notNull().default("cron"), // 'cron' | 'rrule'
  timezone: text("timezone"), // e.g. 'America/Los_Angeles'
  message: text("message").notNull(),
  nextRunAt: integer("next_run_at").notNull(),
  lastRunAt: integer("last_run_at"),
  lastStatus: text("last_status"), // 'ok' | 'error'
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  retryBackoffMs: integer("retry_backoff_ms").notNull().default(60000),
  timeoutMs: integer("timeout_ms"), // script-mode execution timeout override (ms); null = use default
  inferenceProfile: text("inference_profile"), // llm.profiles key for LLM-executed runs; null = default main-agent selection
  createdFromConversationId: text("created_from_conversation_id"),
  createdBy: text("created_by").notNull(), // 'agent' | 'user'
  mode: text("mode").notNull().default("execute"), // 'notify' | 'execute'
  routingIntent: text("routing_intent").notNull().default("all_channels"), // 'single_channel' | 'multi_channel' | 'all_channels'
  routingHintsJson: text("routing_hints_json").notNull().default("{}"),
  status: text("status").notNull().default("active"), // 'active' | 'firing' | 'fired' | 'cancelled'
  quiet: integer("quiet", { mode: "boolean" }).notNull().default(false), // suppress completion notifications
  reuseConversation: integer("reuse_conversation", { mode: "boolean" })
    .notNull()
    .default(false), // reuse the same conversation across runs
  script: text("script"), // shell command for script mode (nullable, only used when mode = 'script')
  wakeConversationId: text("wake_conversation_id"), // target conversation for wake mode (nullable)
  workflowName: text("workflow_name"), // saved workflow to trigger (nullable, only used when mode = 'workflow')
  workflowArgsJson: text("workflow_args_json"), // JSON-encoded args passed to the workflow run (nullable)
  capabilitiesJson: text("capabilities_json"), // JSON-encoded capability manifest for the run (nullable; null = hardcoded read-only manifest)
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

export const heartbeatRuns = sqliteTable("heartbeat_runs", {
  id: text("id").primaryKey(),
  scheduledFor: integer("scheduled_for").notNull(),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  durationMs: integer("duration_ms"),
  status: text("status").notNull(), // 'pending' | 'running' | 'ok' | 'error' | 'timeout' | 'skipped' | 'missed' | 'superseded'
  skipReason: text("skip_reason"), // 'disabled' | 'outside_active_hours' | 'overlap'
  error: text("error"),
  conversationId: text("conversation_id"),
  createdAt: integer("created_at").notNull(),
});

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

export const llmRequestLogs = sqliteTable(
  "llm_request_logs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    messageId: text("message_id"),
    provider: text("provider"),
    requestPayload: text("request_payload").notNull(),
    responsePayload: text("response_payload").notNull(),
    createdAt: integer("created_at").notNull(),
    agentLoopExitReason: text("agent_loop_exit_reason"),
    /**
     * Logical call site that produced this row — e.g. `mainAgent`,
     * `compactionAgent`. Stored as free-form text rather than enum-bound
     * so a new call site can ship without a schema bump, but in practice
     * callers pass values from `LLMCallSite` (`config/schemas/llm.ts`).
     *
     * Historical rows (pre-migration 264) stay NULL — "we don't know"
     * rather than guessing `mainAgent`.
     */
    callSite: text("call_site"),
    /**
     * JSON-serialized first-token latency waterfall measured by the daemon
     * (`LatencyBreakdown` in `api/responses/llm-request-log-entry.ts`):
     * queue → memory/context retrieval → setup → request prep →
     * time-to-first-token → generation. NULL on pre-instrumentation rows,
     * failed calls, and non-main-agent call sites.
     */
    latencyBreakdown: text("latency_breakdown"),
  },
  (table) => [
    index("idx_llm_request_logs_message_id").on(table.messageId),
    index("idx_llm_request_logs_created_at").on(table.createdAt),
  ],
);

export const memoryRecallLogs = sqliteTable(
  "memory_recall_logs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    messageId: text("message_id"),
    enabled: integer("enabled").notNull(),
    degraded: integer("degraded").notNull(),
    provider: text("provider"),
    model: text("model"),
    degradationJson: text("degradation_json"),
    semanticHits: integer("semantic_hits").notNull(),
    mergedCount: integer("merged_count").notNull(),
    selectedCount: integer("selected_count").notNull(),
    tier1Count: integer("tier1_count").notNull(),
    tier2Count: integer("tier2_count").notNull(),
    hybridSearchLatencyMs: integer("hybrid_search_latency_ms").notNull(),
    sparseVectorUsed: integer("sparse_vector_used").notNull(),
    injectedTokens: integer("injected_tokens").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    topCandidatesJson: text("top_candidates_json").notNull(),
    injectedText: text("injected_text"),
    reason: text("reason"),
    queryContext: text("query_context"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_memory_recall_logs_message_id").on(table.messageId),
    index("idx_memory_recall_logs_conversation_id").on(table.conversationId),
  ],
);

export const memoryV2ActivationLogs = sqliteTable(
  "memory_v2_activation_logs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    messageId: text("message_id"),
    turn: integer("turn").notNull(),
    mode: text("mode").notNull(), // "context-load" | "per-turn"
    conceptsJson: text("concepts_json").notNull(),
    skillsJson: text("skills_json").notNull(),
    configJson: text("config_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_memory_v2_activation_logs_message_id").on(table.messageId),
    index("idx_memory_v2_activation_logs_conversation_id").on(
      table.conversationId,
    ),
    index("idx_memory_v2_activation_logs_created_at").on(table.createdAt),
  ],
);

export const llmUsageEvents = sqliteTable(
  "llm_usage_events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    conversationId: text("conversation_id"),
    runId: text("run_id"),
    cronRunId: text("cron_run_id"),
    requestId: text("request_id"),
    actor: text("actor").notNull(),
    callSite: text("call_site"),
    inferenceProfile: text("inference_profile"),
    inferenceProfileSource: text("inference_profile_source"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    /**
     * The provider's untouched `usage` block, serialized as JSON. Anthropic
     * nests the TTL breakdown under `cache_creation.ephemeral_{5m,1h}_input_tokens`;
     * OpenAI nests cached-read details under `prompt_tokens_details`; both are
     * just preserved verbatim so admin charts and downstream consumers can
     * extract whatever provider-specific detail they need without a schema
     * change every time a provider exposes a new field. `null` when the
     * provider didn't return a usage block or for rows persisted before
     * migration 260.
     */
    rawUsage: text("raw_usage"),
    estimatedCostUsd: real("estimated_cost_usd"),
    pricingStatus: text("pricing_status").notNull(),
    llmCallCount: integer("llm_call_count"),
    metadataJson: text("metadata_json"),
    /**
     * Version of the assistant binary at the moment THIS event was
     * recorded (not when the batch was uploaded). Telemetry uploads
     * batch events together and may flush days after the event fired
     * (offline laptop, network outage, ingest clog — see May 2026
     * incident). Stamping at record time keeps the version filter on
     * `/admin/inference` truthful for delayed batches. Null for rows
     * persisted before migration 267 ran.
     */
    assistantVersion: text("assistant_version"),
  },
  (table) => [
    index("idx_llm_usage_events_conversation_id").on(table.conversationId),
  ],
);

// Lives on the dedicated telemetry database (assistant-telemetry.db)
// alongside watchdog_events.
export const lifecycleEvents = sqliteTable("lifecycle_events", {
  id: text("id").primaryKey(),
  eventName: text("event_name").notNull(), // 'app_open' | 'hatch'
  createdAt: integer("created_at").notNull(),
});

// Lives on the dedicated telemetry database (assistant-telemetry.db)
// alongside watchdog_events.
export const onboardingEvents = sqliteTable("onboarding_events", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  screen: text("screen").notNull(),
  toolsJson: text("tools_json"),
  tasksJson: text("tasks_json"),
  tone: text("tone"),
  googleConnected: integer("google_connected", { mode: "boolean" }),
  googleScopesJson: text("google_scopes_json"),
  priorAssistantsJson: text("prior_assistants_json"),
  abVariant: text("ab_variant"),
  sessionId: text("session_id"),
  stepName: text("step_name"),
  stepIndex: integer("step_index"),
  completedAt: text("completed_at"),
  funnelVersion: text("funnel_version"),
});

// Aggregated legacy-loopback auth-fallback counts forwarded by the gateway.
// One row per (guard, path, failure_kind) per flush window; `count` is how many
// requests fell back to the loopback exemption in that window. Flushed to the
// platform telemetry endpoint by the usage telemetry reporter. Lives on the
// dedicated telemetry database (assistant-telemetry.db) alongside
// watchdog_events.
export const authFallbackEvents = sqliteTable("auth_fallback_events", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  guard: text("guard").notNull(), // 'edge' | 'edge-scoped' | 'edge-guardian'
  path: text("path").notNull(),
  failureKind: text("failure_kind").notNull(),
  count: integer("count").notNull(),
  windowStart: integer("window_start").notNull(),
  windowEnd: integer("window_end").notNull(),
});

// One row per conversation started on the activation-rail bootstrap template.
// Lets the activation funnel telemetry scope its events to activation
// conversations without inspecting the bootstrap template at emit time.
export const activationSessions = sqliteTable("activation_sessions", {
  conversationId: text("conversation_id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

// One row per `skill_loaded` telemetry event, emitted when a Vellum-produced
// skill is activated in a conversation — see skill-loaded-events-store.ts for
// the data contract. Flushed by the usage telemetry reporter. Lives on the
// dedicated telemetry database (assistant-telemetry.db) alongside
// watchdog_events.
export const skillLoadedEvents = sqliteTable(
  "skill_loaded_events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    conversationId: text("conversation_id"),
    skillName: text("skill_name").notNull(),
    // ISO 8601 timestamp from the merged skill catalog, when known.
    skillUpdatedAt: text("skill_updated_at"),
    provider: text("provider"),
    model: text("model"),
    inferenceProfile: text("inference_profile"),
    inferenceProfileSource: text("inference_profile_source"),
  },
  (table) => [
    index("idx_skill_loaded_events_created_at_id").on(
      table.createdAt,
      table.id,
    ),
  ],
);

// One row per `watchdog` telemetry event, emitted when a daemon watchdog
// check fires (event-loop block, stream-idle stall, restart, ...) — see
// watchdog-events-store.ts for the data contract. Flushed by the usage
// telemetry reporter. `value` is a REAL (BQ FLOAT) so the daemon need not
// distinguish int vs float; the platform serializer coerces ints to float.
// `detail` is a JSON bag stored as text and forwarded verbatim.
export const watchdogEvents = sqliteTable(
  "watchdog_events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    checkName: text("check_name").notNull(),
    value: real("value"),
    detail: text("detail"),
  },
  (table) => [
    index("idx_watchdog_events_created_at_id").on(table.createdAt, table.id),
  ],
);

// Key/value store for telemetry flush state — the per-event-type
// `(last_reported_at, last_reported_id)` watermark cursors advanced by the
// usage telemetry reporter after each successful upload. Lives on the
// dedicated telemetry database (assistant-telemetry.db) so flush state
// stays with the telemetry pipeline; the main DB's `memory_checkpoints`
// ledger is reserved for DB-migration checkpoints.
export const flushCheckpoints = sqliteTable("flush_checkpoints", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// One row per `config_setting` telemetry event — a tracked config key's
// effective value; see config-setting-events-store.ts for the data
// contract. Lives on the dedicated telemetry database
// (assistant-telemetry.db) alongside watchdog_events. Flushed by the usage
// telemetry reporter.
export const configSettingEvents = sqliteTable(
  "config_setting_events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    configKey: text("config_key").notNull(),
    configValue: text("config_value").notNull(),
  },
  (table) => [
    index("idx_config_setting_events_created_at_id").on(
      table.createdAt,
      table.id,
    ),
  ],
);

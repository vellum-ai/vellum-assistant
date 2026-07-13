import type { LLMCallSite } from "../config/schemas/llm.js";
import type { UsageAttributionProfileSource } from "../usage/types.js";

/** Base fields present on every telemetry event. */
export interface TelemetryEventBase {
  type: string;
  daemon_event_id: string;
  recorded_at: number;
  /**
   * Version of the assistant binary at the moment THIS event was
   * RECORDED (not when the batch was uploaded). Distinct from the
   * envelope's `assistant_version` field, which still ships for
   * back-compat with platforms that haven't deployed the per-event
   * handling.
   *
   * The platform's `TelemetryIngestView` prefers per-event over
   * envelope: when a per-event value is present (including explicit
   * `null`) it wins. When the field is omitted on the event entirely
   * (old assistant), the envelope value is the back-compat fallback.
   *
   * Daemon-side, this field is always non-null. The outbox-backed
   * event types store the full wire payload at record time, so their
   * `APP_VERSION` stamp is genuinely record-time; `llm_usage` carries
   * a record-time column (legacy rows from before migration 267 fall
   * back to the flushing binary's `APP_VERSION`); `turn` and
   * `tool_executed` derive from tables without a version column and
   * stamp the flushing binary's `APP_VERSION`. Stamping `APP_VERSION`
   * instead of emitting explicit `null` preserves envelope-equivalent
   * behavior under the per-event-wins contract. The type allows
   * `null` for parity with the platform contract; in practice the
   * daemon never sends it.
   */
  assistant_version: string | null;
}

/**
 * Base for telemetry events that occur in the context of a model call.
 * Standardizes model attribution across event types — field names/shapes
 * mirror the existing llm_usage event so downstream consumers (dbt, admin
 * charts) can join/group consistently.
 *
 * `provider`/`model` are nullable on the wire because rows persisted before
 * the attribution columns existed, and rows whose attribution resolution
 * failed, must still ship; the platform serializer accepts null.
 */
export interface ModelTelemetryEventBase extends TelemetryEventBase {
  /** Provider serving the call, e.g. "anthropic", "fireworks". */
  provider: string | null;
  /** Model id active for the call, e.g. "claude-fable-5". */
  model: string | null;
  /** Inference profile slug. Null when no profile applied. */
  inference_profile: string | null;
  /** How the profile was attributed (same enum as llm_usage). */
  inference_profile_source: UsageAttributionProfileSource | null;
}

/**
 * LLM usage event — one per persisted usage row. The main agent loop
 * persists a single row per turn with token totals summed across every
 * provider API call in the loop (`llm_call_count` carries the call count);
 * auxiliary call sites persist one row per call.
 */
export interface LlmUsageTelemetryEvent extends TelemetryEventBase {
  type: "llm_usage";
  /**
   * Parent conversation id. Null for LLM calls not tied to a conversation
   * (memory consolidation, background embedding work, etc.).
   */
  conversation_id: string | null;
  /**
   * Type of the parent conversation (`"standard"` / `"background"` /
   * `"scheduled"`). Null when `conversation_id` is null. Daemons predating
   * this field send no value; downstream consumers treat missing/null as
   * `"standard"` to preserve back-compat during rollout.
   */
  conversation_type: string | null;
  /**
   * 1-indexed position of the user turn this LLM call belongs to within
   * the parent conversation, counting only real user turns (tool-result
   * rows persisted with role="user" are excluded — same filter as the
   * `turn` event stream). Computed as the count of user messages with
   * `created_at <= this_event.created_at`. Null when the LLM call isn't
   * tied to a conversation, or when no user turn has occurred yet.
   */
  turn_index: number | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  /**
   * Number of provider API calls aggregated into this event. The main
   * agent loop persists one usage row per turn with token totals summed
   * across every call in the loop, so this is how downstream consumers
   * recover per-call averages (effective tokens ÷ calls). Auxiliary call
   * sites record exactly 1. Null for rows persisted before daemon
   * migration `200-usage-llm-call-count`; consumers treat null as 1.
   */
  llm_call_count: number | null;
  /**
   * The provider's untouched `usage` block. Anthropic surfaces a TTL
   * breakdown under `cache_creation.ephemeral_{5m,1h}_input_tokens`;
   * OpenAI surfaces cached-read counts under
   * `prompt_tokens_details.cached_tokens` (and reasoning tokens under
   * `completion_tokens_details`). Both shapes are forwarded verbatim so
   * downstream consumers (admin charts, dbt models) can extract any
   * provider-specific detail without requiring a schema change here.
   * Null when the provider did not return a usage payload, and for
   * daemons that predate `260-llm-usage-add-raw-usage`.
   */
  raw_usage: Record<string, unknown> | null;
  actor: string;
  llm_call_site: LLMCallSite | null;
  inference_profile: string | null;
  inference_profile_source: UsageAttributionProfileSource | null;
  /** Computed estimated cost in USD for this LLM call. Null when pricing data is unavailable. */
  cost: number | null;
}

/**
 * Optional client metadata bag carried on `TurnTelemetryEvent.client`.
 * Sourced from `messages.metadata.client`. Today only `os` is populated —
 * stamped by `persistQueuedMessageBody` from the request body's `clientOs`
 * field; the remaining fields are declared for clients that send them.
 * Extensible without a schema change — lives entirely in the JSON metadata
 * column.
 */
export interface TurnTelemetryClientInfo {
  /** Browser family for `web`/`chrome-extension` interfaces: `"chrome"|"safari"|"firefox"|"edge"`. */
  browser_family?: string;
  /** Major browser version only (`"124"`, not the full UA string). */
  browser_version?: string;
  /**
   * OS surface reported by the client at message time
   * ("web" | "ios" | "macos" | "android"). The web, iOS, and macOS apps all
   * run the same web renderer and report `interface_id: "web"` (the
   * transport surface, which host-proxy capability gating keys off), so
   * this field is the only per-platform attribution in turn telemetry.
   */
  os?: string;
  /**
   * Version of the surface app/client (`"0.8.2"` for the macOS app,
   * web client SHA, etc.) — distinct from `assistant_version` on the
   * batch envelope, which identifies the daemon. A user can be on an
   * older surface than the daemon (or vice versa, on web).
   */
  interface_version?: string;
}

/**
 * One message in a turn trace. `role` is the stored `messages.role`
 * (`"user"` / `"assistant"` / `"system"`); tool-result rows persisted with
 * role `"user"` keep that role here so the transcript is faithful to what was
 * sent to the model. `content` is the parsed `messages.content` — either the
 * modern `ContentBlock[]` (text / tool_use / tool_result / thinking / image /
 * file blocks) or a legacy plain string. Stored verbatim by the platform as an
 * opaque JSON column, so the shape is self-describing rather than normalized.
 */
export interface TurnTraceMessage {
  /** `messages.id` — stable per-row id. */
  id: string;
  /** Stored role of the message row. */
  role: string;
  /** Epoch-ms `messages.created_at`. */
  created_at: number;
  /**
   * Parsed `messages.content`. `unknown` because it is forwarded verbatim:
   * modern rows are `ContentBlock[]`, legacy rows are a plain string.
   */
  content: unknown;
  /**
   * Model that served this row — the provider's `response.model`, carried on
   * the agent loop's `message_complete` event and persisted with the row
   * (`messages.metadata.model`); matches the turn's `llm_usage.model` and
   * reflects per-call reroutes by a `pre-model-call` hook. Null on rows with
   * no model call: user rows, tool-result rows, synthetic assistant rows
   * (provider-error / yield notices), and historical rows persisted before the
   * daemon began stamping the model.
   */
  model: string | null;
}

/**
 * One tool invocation in a turn trace, projected from the `tool_invocations`
 * audit table for the turn window. Carries the full tool call + result so the
 * platform sees the same transcript the assistant did. Both `input` and
 * `result` are captured verbatim (full-fidelity) — no field-level redaction is
 * applied. The protections for this PII are the owner consent gate, the
 * PII-segregated `pii_turn_raw` table, and its 30-day TTL.
 */
export interface TurnTraceToolCall {
  /** `tool_invocations.id`. */
  id: string;
  tool_name: string;
  /** Verbatim tool input — parsed JSON when it parses, else the raw string. */
  input: unknown;
  /** Stored tool result string (verbatim). */
  result: string;
  /** Audit decision (`"allow"` / `"error"` / …). */
  decision: string;
  duration_ms: number;
  created_at: number;
}

/**
 * Full transcript of a single turn — the user message, assistant response
 * message(s), and the tool calls + results that occurred between this user
 * turn and the next real user turn. Attached to the turn telemetry event's
 * `trace` field ONLY when trace collection is enabled — the owner's
 * `share_diagnostics` consent at an eligible accepted version.
 * The platform stores this verbatim as an opaque JSON column, so the daemon
 * owns the shape.
 *
 * Each turn's trace is its natural window. A turn whose window holds no
 * assistant response (a coalesced-batch head, or a turn that failed/cancelled
 * before responding) traces user-only — faithful, since its window genuinely
 * has no response. A coalesced batch's shared response lives on the batch's
 * final turn's window, where the daemon already attributes it.
 */
/** Tool definition included in the trace — name, description, and full input
 * schema so the trace shows exactly what the model had available. */
export interface TurnTraceToolDefinition {
  name: string;
  description: string;
  /** JSON schema describing the tool's input arguments. */
  input_schema: Record<string, unknown>;
}

export interface TurnTrace {
  /** Shape version so the platform/dbt can evolve parsing without ambiguity. */
  schema_version: 3;
  /**
   * Ordered message rows for the turn (the user message first, then assistant
   * responses and any tool-result rows), oldest-first by `(created_at, id)`.
   * Model attribution is per message — each assistant row carries the model
   * that served it on `TurnTraceMessage.model`.
   */
  messages: TurnTraceMessage[];
  /**
   * Tool invocations that occurred during the turn window, oldest-first. May
   * be empty for turns with no tool use. Projected from `tool_invocations`,
   * which complements the inline tool_use/tool_result blocks in `messages`.
   */
  tool_calls: TurnTraceToolCall[];
  /**
   * The system prompt sent to the provider for this turn. Read from the live
   * conversation's cached prompt at trace assembly time. Null when the
   * conversation has been evicted from memory by the time the trace is
   * assembled (e.g. after a daemon restart).
   */
  system_prompt: string | null;
  /**
   * Tool definitions available to the model for this turn — name,
   * description, and full input schema, matching what the provider received.
   * Read from the live conversation's last resolved tool set. Empty when the
   * conversation has been evicted.
   */
  tool_definitions: TurnTraceToolDefinition[];
}

/** Turn event — one per user message. */
export interface TurnTelemetryEvent extends TelemetryEventBase {
  type: "turn";
  /**
   * Parent conversation id. Lets analytics group turns by conversation
   * (e.g. avg turns per conversation, time-to-first-completion).
   */
  conversation_id: string;
  /**
   * Type of the parent conversation. Lets analytics distinguish
   * user-initiated turns (`"standard"`) from system-generated prompts
   * in `"background"` / `"scheduled"` conversations. Daemons predating
   * this field send no value; downstream consumers should treat a
   * missing value as `"standard"` to preserve DAU during rollout.
   */
  conversation_type: string;
  /**
   * 1-indexed position of this user turn within the parent conversation,
   * counting only real user turns (tool-result rows persisted with
   * role="user" are excluded — same filter as the turn-event eligibility
   * predicate). The first user turn in a conversation is `1`.
   */
  turn_index: number;
  /**
   * Canonical `InterfaceId` enum value identifying the UI surface the
   * user was interacting from when this turn was created (`"macos"`,
   * `"ios"`, `"cli"`, `"web"`, `"chrome-extension"`, `"slack"`,
   * `"telegram"`, `"whatsapp"`, `"email"`, `"phone"`). Sourced from the
   * `userMessageInterface` field already stamped on `messages.metadata`
   * by every `persistUserMessage` path that flows through
   * `TurnChannelContext`.
   *
   * Null when the metadata didn't carry the field — historical rows or
   * system-initiated turns with no inbound client context. Downstream
   * consumers should treat null as `"unknown"`.
   */
  interface_id: string | null;
  /**
   * Canonical `ChannelId` enum value identifying the messaging fabric the
   * user message arrived on (`"vellum"` for in-app from macos/ios/web/
   * cli/chrome-extension; `"slack"`/`"telegram"`/`"whatsapp"`/`"email"`/
   * `"phone"` for channel-based interfaces). The 7th `ChannelId` value
   * (`"platform"`) is APNs-push outbound-only and should never appear
   * here.
   */
  channel_id: string | null;
  /**
   * Optional client-side metadata bag. Null when no client headers were
   * attached to the request that created the user message (most
   * channel-inbound paths today, and any path the new HTTP header
   * middleware hasn't been wired to yet).
   */
  client: TurnTelemetryClientInfo | null;
  /**
   * Explicit abnormal turn outcome, stamped by the daemon at turn end:
   *
   * - `"batched"` — the user message was coalesced into a later turn's
   *   shared response (`drainBatch`); its own window holds no assistant
   *   message by design. `batched_into` identifies the turn that replied.
   * - `"failed"` — the agent loop terminated in a non-cancellation error.
   *   Includes turns whose only assistant output is the synthetic
   *   provider-error message, so failure analytics don't need to
   *   text-match error copy.
   * - `"cancelled"` — the user cancelled the turn (stop / barge-in).
   *
   * Omitted when the turn replied normally, when the daemon predates
   * outcome stamping, or when the process died mid-turn before a stamp
   * could land — so `absent + no assistant message in trace` isolates the
   * genuinely anomalous (crashed/unknown) turns.
   */
  outcome?: "batched" | "failed" | "cancelled";
  /**
   * For `outcome: "batched"` turns: the `daemon_event_id` of the
   * batch-final turn whose window carries the shared response. Omitted
   * otherwise.
   */
  batched_into?: string;
  /**
   * For `outcome: "failed"` turns: the stable classified error code
   * (`classifyConversationError(...).code`, a `ConversationErrorCode`
   * value like `"PROVIDER_RATE_LIMIT"` or `"MANAGED_USAGE_LIMIT"`). Never
   * free-form error text. Omitted otherwise or when the failure had no
   * classification.
   */
  failure_code?: string;
  /**
   * Full per-turn transcript (user message + assistant responses + tool
   * calls/results). Present ONLY when trace collection is enabled — the daemon
   * composes the gate itself from the owner's cached `share_diagnostics`
   * consent AND the accepted consent version being at or past the disclosing
   * version. Fail-closed: when either is off (or unknown) no trace
   * is attached. The platform dual-writes consented traces into a separate PII
   * table and keeps the trace-free turn row; downstream consumers that don't
   * read traces ignore this field. Null / absent when the gate is off or the
   * serialized trace exceeded the size cap.
   */
  trace?: TurnTrace | null;
}

/** Lifecycle event — app_open, hatch, etc. */
export interface LifecycleTelemetryEvent extends TelemetryEventBase {
  type: "lifecycle";
  event_name: string;
}

/** Onboarding event — pre-chat selections and Google connect status. */
export interface OnboardingTelemetryEvent extends TelemetryEventBase {
  type: "onboarding";
  screen: string;
  tools?: string[];
  tasks?: string[];
  tone?: string;
  google_connected?: boolean;
  google_scopes?: string[];
  ab_variant?: string;
  /**
   * Activation-funnel fields (mirror the web funnel shape and the platform
   * serializer). The platform accepts an onboarding event via either the
   * legacy `screen` path or the all-funnel-fields path (`session_id` +
   * `step_name` + `step_index` + `completed_at` + `funnel_version` +
   * `ab_variant`).
   */
  session_id?: string;
  step_name?: string;
  step_index?: number;
  completed_at?: string;
  funnel_version?: string;
  user_id?: string;
}

/**
 * Auth-fallback event — aggregated count of requests served via the legacy
 * loopback auth fallback. One event per (guard, path, failure_kind) per flush
 * window. Lets the platform see which deployments still rely on the loopback
 * exemption instead of sending a bearer token.
 */
export interface AuthFallbackTelemetryEvent extends TelemetryEventBase {
  type: "auth_fallback";
  /** Which auth guard fell back: `"edge"` | `"edge-scoped"` | `"edge-guardian"`. */
  guard: string;
  /** Request pathname that fell back. */
  path: string;
  /**
   * Why the bearer-token check did not succeed before the fallback:
   * `"missing_authorization"` | `"malformed_authorization"` |
   * `"token_validation_failed"` | `"insufficient_scope"` |
   * `"non_actor_principal"` | `"guardian_mismatch"`.
   */
  failure_kind: string;
  /** Number of requests that fell back for this key during the window. */
  count: number;
  /** Window start (epoch ms) the count was accumulated over. */
  window_start: number;
  /** Window end (epoch ms) the count was accumulated over. */
  window_end: number;
}

/**
 * Tool-executed event — one per tool invocation. Carries NO tool
 * args/inputs or result contents (customer PII per ToS) — payload sizes
 * and metadata only; no raw error messages. Identity/attribution come
 * from the upload envelope per the per-event-wins contract. Not to be
 * confused with the since-reverted `tool_execution` permission-audit
 * event, which no longer exists on the wire.
 */
export interface ToolExecutedTelemetryEvent extends ModelTelemetryEventBase {
  type: "tool_executed";
  tool_name: string;
  /**
   * `"errored"` means the invocation failed at the execution layer — a
   * thrown error / infra failure (audit decision `"error"`). A tool that
   * runs to completion but returns an `isError` result payload still
   * counts as `"fulfilled"`: it executed.
   */
  status: "fulfilled" | "errored";
  duration_ms: number;
  /** Serialized tool-argument size in bytes. Null when unknown. */
  arg_bytes: number | null;
  /** Serialized tool-result size in bytes. Null when unknown. */
  result_bytes: number | null;
  conversation_id: string | null;
}

/**
 * Skill-loaded event — one per skill load. Emitted only for
 * Vellum-produced skills (bundled, or managed with vellum origin).
 * Metadata only — no skill output or conversation content.
 */
export interface SkillLoadedTelemetryEvent extends ModelTelemetryEventBase {
  type: "skill_loaded";
  skill_name: string;
  /**
   * ISO 8601 timestamp — the catalog's `updatedAt`, effectively the
   * skill version. Null when the catalog carries no timestamp.
   */
  skill_updated_at: string | null;
  conversation_id: string | null;
}

/**
 * Watchdog health event — one per watchdog check firing. The daemon's
 * watchdog observes liveness/health signals (event-loop block, stream-idle
 * stalls, restarts, ...) and emits one event per check firing.
 *
 * Deliberately minimal and forward-compatible, mirroring the platform
 * `WatchdogTelemetryEventSerializer`:
 *
 *   - `check_name` — which watchdog check fired. Open string set (not a
 *     closed enum) so the daemon can introduce a new check without a
 *     coordinated serializer release; it is the primary group-by dimension
 *     downstream. The infrastructure admin chart filters this to
 *     `event_loop_blocked`.
 *   - `value` — the single measured magnitude for the check (block ms, idle
 *     ms, ...). Nullable: not every check carries a scalar. The platform
 *     coerces ints to float, so the daemon need not distinguish.
 *   - `detail` — open JSON bag for any extra fields the daemon attaches
 *     (reason codes, secondary numbers, a human message) without a
 *     platform-coordinated schema change. Null when the daemon attaches
 *     nothing. Bounded server-side (4096 bytes serialized); an oversize bag
 *     rejects only the single event, never the batch.
 *
 * Metadata only — no conversation content. Dedupe downstream on
 * `daemon_event_id` (the daemon retries a batch on transient POST failure).
 */
export interface WatchdogTelemetryEvent extends TelemetryEventBase {
  type: "watchdog";
  check_name: string;
  value: number | null;
  detail: Record<string, unknown> | null;
}

/**
 * Config-setting event — records a tracked config key's effective value.
 * A single string:string pair on top of the standard envelope, mirroring
 * the platform `ConfigSettingTelemetryEventSerializer`:
 *
 *   - `config_key` — dotted config path (e.g. `"memory.enabled"`).
 *     Bounded server-side at 128 chars.
 *   - `config_value` — the effective value rendered as a string
 *     (`"true"` / `"false"` for booleans). Bounded server-side at 256
 *     chars.
 *
 * Metadata only — emitters record an explicit allowlist of non-sensitive
 * settings, never free-form config content. Dedupe downstream on
 * `daemon_event_id` (the daemon retries a batch on transient POST failure).
 */
export interface ConfigSettingTelemetryEvent extends TelemetryEventBase {
  type: "config_setting";
  config_key: string;
  config_value: string;
}

/** Discriminated union of all telemetry event types. */
export type TelemetryEvent =
  | LlmUsageTelemetryEvent
  | TurnTelemetryEvent
  | LifecycleTelemetryEvent
  | OnboardingTelemetryEvent
  | AuthFallbackTelemetryEvent
  | ToolExecutedTelemetryEvent
  | SkillLoadedTelemetryEvent
  | WatchdogTelemetryEvent
  | ConfigSettingTelemetryEvent;

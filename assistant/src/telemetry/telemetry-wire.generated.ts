// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: django/app/assistant/self_hosted_local/serializers.py
// Regenerate with `make generate-telemetry-wire` (run from `django/`).
//
// This file must stay deterministic — never embed timestamps or commit SHAs —
// so regeneration is diff-stable and CI can enforce freshness.

import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// Byte length of the JSON serialization as the SERVER measures it: Python
// `json.dumps(value, separators=(",", ":"))` with the default
// `ensure_ascii=True`, then UTF-8-encoded. ensure_ascii escapes every code
// point above 0x7E (including 0x7F DEL) as a 6-byte `\uXXXX` sequence —
// astral chars become surrogate pairs, i.e. two escapes, 12 bytes — so the
// escaped JSON is pure ASCII and its byte length equals its character count.
// JSON.stringify already escapes quotes, backslashes, and ASCII control
// chars identically to Python, so replacing each remaining UTF-16 code unit
// above 0x7E with a six-char placeholder reproduces the server's byte count
// exactly. Counting raw UTF-8 instead would undercount non-ASCII text ~3x
// and let payloads through that the server silently drops.
const jsonByteLength = (v: unknown): number =>
  JSON.stringify(v).replace(/[^\x00-\x7e]/g, "\\uxxxx").length;

// ---- Server-side ingest bounds ----
// Introspected from the ingest serializer class attributes at
// generation time, so a server-side bump regenerates automatically.
// A daemon-sent event violating a bound below is REJECTED by ingest
// (logged server-side, silently dropped from the daemon's point of
// view) — except `trace`, see TURN_TRACE_MAX_JSON_BYTES.
export const TURN_CLIENT_MAX_KEYS = 16;
export const TURN_CLIENT_MAX_KEY_LEN = 64;
export const TURN_CLIENT_MAX_VALUE_LEN = 256;
export const TURN_CLIENT_MAX_JSON_BYTES = 2048;
// The server does NOT reject a turn event whose `trace` exceeds this
// bound: it drops (nulls) the trace and keeps the event (see
// TurnTelemetryEventSerializer.validate_trace). Client-side rejection
// would therefore be wrong, so there is deliberately no `trace`
// refinement on the turn schema. The daemon may use this constant to
// pre-trim a trace it would rather not lose.
export const TURN_TRACE_MAX_JSON_BYTES = 262144;
export const WATCHDOG_DETAIL_MAX_JSON_BYTES = 4096;
export const ONBOARDING_RESEARCH_CLAIMS_MAX_JSON_BYTES = 8192;
export const ONBOARDING_RESEARCH_SUGGESTIONS_MAX_JSON_BYTES = 8192;

export const llmUsageTelemetryEventSchema = z.object({
  type: z.literal("llm_usage"),
  daemon_event_id: z.string().trim().min(1).max(128),
  recorded_at: z.number().int(),
  assistant_version: z.string().trim().min(1).max(64).nullable().optional(),
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(128),
  llm_call_site: z.string().trim().min(1).max(255).nullable().optional(),
  inference_profile: z.string().trim().min(1).max(255).nullable().optional(),
  inference_profile_source: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .nullable()
    .optional(),
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cache_creation_input_tokens: z.number().int().min(0).nullable().optional(),
  raw_usage: jsonValueSchema.nullable().optional(),
  cache_read_input_tokens: z.number().int().min(0).nullable().optional(),
  actor: z.string().trim().min(1).max(64),
  cost: z.number().min(0).nullable().optional(),
  conversation_id: z.string().trim().min(1).max(64).nullable().optional(),
  conversation_type: z.string().trim().min(1).max(32).nullable().optional(),
  turn_index: z.number().int().min(0).nullable().optional(),
  llm_call_count: z.number().int().min(1).nullable().optional(),
});
export type LlmUsageTelemetryEvent = z.infer<
  typeof llmUsageTelemetryEventSchema
>;

export const turnTelemetryEventSchema = z
  .object({
    type: z.literal("turn"),
    daemon_event_id: z.string().trim().min(1).max(128),
    recorded_at: z.number().int(),
    assistant_version: z.string().trim().min(1).max(64).nullable().optional(),
    conversation_type: z.string().trim().min(1).max(32).nullable().optional(),
    conversation_id: z.string().trim().min(1).max(64).nullable().optional(),
    turn_index: z.number().int().min(1).nullable().optional(),
    interface_id: z.string().trim().min(1).max(64).nullable().optional(),
    channel_id: z.string().trim().min(1).max(64).nullable().optional(),
    client: z.record(z.string(), jsonValueSchema).nullable().optional(),
    outcome: z.string().trim().min(1).max(32).nullable().optional(),
    batched_into: z.string().trim().min(1).max(64).nullable().optional(),
    failure_code: z.string().trim().min(1).max(64).nullable().optional(),
    trace: jsonValueSchema.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    // Mirrors the server's TurnTelemetryEventSerializer.validate_client —
    // a `client` bag violating these bounds is rejected by ingest (the
    // event is silently dropped, never the whole batch).
    if (val.client === null || val.client === undefined) {
      return;
    }
    const entries = Object.entries(val.client);
    if (entries.length > TURN_CLIENT_MAX_KEYS) {
      ctx.addIssue({
        code: "custom",
        path: ["client"],
        message: `\`client\` may have at most ${TURN_CLIENT_MAX_KEYS} keys; got ${entries.length}.`,
      });
    }
    for (const [key, value] of entries) {
      if (key.length > TURN_CLIENT_MAX_KEY_LEN) {
        ctx.addIssue({
          code: "custom",
          path: ["client", key],
          message: `\`client\` keys must be strings of at most ${TURN_CLIENT_MAX_KEY_LEN} chars.`,
        });
      }
      if (typeof value === "object" && value !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["client", key],
          message: `\`client\` values must be primitives (string / number / boolean / null), not nested objects or arrays.`,
        });
      }
      if (
        typeof value === "string" &&
        value.length > TURN_CLIENT_MAX_VALUE_LEN
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["client", key],
          message: `\`client\` string values must be at most ${TURN_CLIENT_MAX_VALUE_LEN} chars.`,
        });
      }
    }
    if (jsonByteLength(val.client) > TURN_CLIENT_MAX_JSON_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["client"],
        message: `\`client\` JSON exceeds ${TURN_CLIENT_MAX_JSON_BYTES} bytes when serialized.`,
      });
    }
  });
export type TurnTelemetryEvent = z.infer<typeof turnTelemetryEventSchema>;

export const lifecycleTelemetryEventSchema = z.object({
  type: z.literal("lifecycle"),
  daemon_event_id: z.string().trim().min(1).max(128),
  recorded_at: z.number().int(),
  assistant_version: z.string().trim().min(1).max(64).nullable().optional(),
  event_name: z.string().trim().min(1).max(64),
});
export type LifecycleTelemetryEvent = z.infer<
  typeof lifecycleTelemetryEventSchema
>;

export const onboardingTelemetryEventSchema = z
  .object({
    type: z.literal("onboarding"),
    daemon_event_id: z.string().trim().min(1).max(128),
    recorded_at: z.number().int(),
    assistant_version: z.string().trim().min(1).max(64).nullable().optional(),
    screen: z.string().trim().min(1).max(64).optional(),
    tools: z.array(z.string().trim().min(1).max(128)).optional(),
    tasks: z.array(z.string().trim().min(1).max(128)).optional(),
    tone: z.string().trim().min(1).max(64).optional(),
    google_connected: z.boolean().optional(),
    google_scopes: z.array(z.string().trim().min(1).max(256)).optional(),
    ab_variant: z.string().trim().min(1).max(64).optional(),
    session_id: z.string().trim().min(1).max(128).optional(),
    step_name: z.string().trim().min(1).max(128).optional(),
    step_index: z.number().int().min(0).optional(),
    completed_at: z.string().trim().min(1).max(64).optional(),
    funnel_version: z.string().trim().min(1).max(128).optional(),
    user_id: z.string().trim().min(1).max(64).nullable().optional(),
    outcome: z.string().trim().min(1).max(32).optional(),
  })
  .superRefine((val, ctx) => {
    // Mirrors the server's OnboardingTelemetryEventSerializer.validate —
    // an onboarding event needs either a non-empty legacy `screen` or the
    // COMPLETE pre-chat funnel step field set; anything else is rejected
    // by ingest (silently dropped).
    const hasLegacyScreenEvent = Boolean(val.screen);
    const hasStepEvent = [
      val.session_id,
      val.step_name,
      val.step_index,
      val.completed_at,
      val.funnel_version,
      val.ab_variant,
    ].every((field) => field !== null && field !== undefined);
    if (!hasLegacyScreenEvent && !hasStepEvent) {
      ctx.addIssue({
        code: "custom",
        message:
          "Onboarding telemetry requires either `screen` or the complete pre-chat funnel step fields.",
      });
    }
  });
export type OnboardingTelemetryEvent = z.infer<
  typeof onboardingTelemetryEventSchema
>;

export const authFallbackTelemetryEventSchema = z.object({
  type: z.literal("auth_fallback"),
  daemon_event_id: z.string().trim().min(1).max(128),
  recorded_at: z.number().int(),
  assistant_version: z.string().trim().min(1).max(64).nullable().optional(),
  guard: z.string().trim().min(1).max(64),
  failure_kind: z.string().trim().min(1).max(64),
  path: z.string().trim().min(1).max(2048),
  count: z.number().int().min(0),
  window_start: z.number().int().min(0),
  window_end: z.number().int().min(0),
});
export type AuthFallbackTelemetryEvent = z.infer<
  typeof authFallbackTelemetryEventSchema
>;

export const toolExecutedTelemetryEventSchema = z.object({
  provider: z.string().trim().min(1).max(64).nullable().optional(),
  model: z.string().trim().min(1).max(128).nullable().optional(),
  inference_profile: z.string().trim().min(1).max(255).nullable().optional(),
  inference_profile_source: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .nullable()
    .optional(),
  type: z.literal("tool_executed"),
  daemon_event_id: z.string().trim().min(1).max(128),
  recorded_at: z.number().int(),
  assistant_version: z.string().trim().min(1).max(64).nullable().optional(),
  tool_name: z.string().trim().min(1).max(255),
  status: z.string().trim().min(1).max(32),
  duration_ms: z.number().int().min(0).nullable().optional(),
  arg_bytes: z.number().int().min(0).nullable().optional(),
  result_bytes: z.number().int().min(0).nullable().optional(),
  conversation_id: z.string().trim().min(1).max(128).nullable().optional(),
});
export type ToolExecutedTelemetryEvent = z.infer<
  typeof toolExecutedTelemetryEventSchema
>;

export const skillLoadedTelemetryEventSchema = z.object({
  provider: z.string().trim().min(1).max(64).nullable().optional(),
  model: z.string().trim().min(1).max(128).nullable().optional(),
  inference_profile: z.string().trim().min(1).max(255).nullable().optional(),
  inference_profile_source: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .nullable()
    .optional(),
  type: z.literal("skill_loaded"),
  daemon_event_id: z.string().trim().min(1).max(128),
  recorded_at: z.number().int(),
  assistant_version: z.string().trim().min(1).max(64).nullable().optional(),
  skill_name: z.string().trim().min(1).max(255),
  skill_updated_at: z.string().trim().min(1).max(64).nullable().optional(),
  conversation_id: z.string().trim().min(1).max(128).nullable().optional(),
});
export type SkillLoadedTelemetryEvent = z.infer<
  typeof skillLoadedTelemetryEventSchema
>;

export const watchdogTelemetryEventSchema = z
  .object({
    type: z.literal("watchdog"),
    daemon_event_id: z.string().trim().min(1).max(128),
    recorded_at: z.number().int(),
    assistant_version: z.string().trim().min(1).max(64).nullable().optional(),
    check_name: z.string().trim().min(1).max(128),
    value: z.number().nullable().optional(),
    detail: jsonValueSchema.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    // Mirrors the server's WatchdogTelemetryEventSerializer.validate_detail —
    // an oversize `detail` bag is rejected by ingest (the event is silently
    // dropped, never the whole batch).
    if (val.detail === null || val.detail === undefined) {
      return;
    }
    if (jsonByteLength(val.detail) > WATCHDOG_DETAIL_MAX_JSON_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["detail"],
        message: `\`detail\` JSON exceeds ${WATCHDOG_DETAIL_MAX_JSON_BYTES} bytes when serialized.`,
      });
    }
  });
export type WatchdogTelemetryEvent = z.infer<
  typeof watchdogTelemetryEventSchema
>;

export const configSettingTelemetryEventSchema = z.object({
  type: z.literal("config_setting"),
  daemon_event_id: z.string().trim().min(1).max(128),
  recorded_at: z.number().int(),
  assistant_version: z.string().trim().min(1).max(64).nullable().optional(),
  config_key: z.string().trim().min(1).max(128),
  config_value: z.string().trim().min(1).max(256),
});
export type ConfigSettingTelemetryEvent = z.infer<
  typeof configSettingTelemetryEventSchema
>;

export const onboardingResearchTelemetryEventSchema = z
  .object({
    type: z.literal("onboarding_research"),
    daemon_event_id: z.string().trim().min(1).max(128),
    recorded_at: z.number().int(),
    assistant_version: z.string().trim().min(1).max(64).nullable().optional(),
    conversation_id: z.string().trim().min(1).max(64).nullable().optional(),
    status: z.string().trim().min(1).max(32),
    claims: z.array(jsonValueSchema).max(20),
    claim_count: z.number().int().min(0),
    claims_confident: z.number().int().min(0),
    claims_maybe: z.number().int().min(0),
    claims_guessing: z.number().int().min(0),
    suggestions: z.array(jsonValueSchema).max(20),
    suggestion_count: z.number().int().min(0),
    plugins: z.array(z.string().trim().min(1).max(128)).max(20),
    installed_plugins: z.array(z.string().trim().min(1).max(128)).max(20),
  })
  .superRefine((val, ctx) => {
    // Mirrors the server's OnboardingResearchTelemetryEventSerializer
    // validate_claims / validate_suggestions — an oversize `claims` or
    // `suggestions` array is rejected by ingest (the event is silently
    // dropped, never the whole batch).
    if (
      jsonByteLength(val.claims) > ONBOARDING_RESEARCH_CLAIMS_MAX_JSON_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["claims"],
        message: `\`claims\` JSON exceeds ${ONBOARDING_RESEARCH_CLAIMS_MAX_JSON_BYTES} bytes when serialized.`,
      });
    }
    if (
      jsonByteLength(val.suggestions) >
      ONBOARDING_RESEARCH_SUGGESTIONS_MAX_JSON_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["suggestions"],
        message: `\`suggestions\` JSON exceeds ${ONBOARDING_RESEARCH_SUGGESTIONS_MAX_JSON_BYTES} bytes when serialized.`,
      });
    }
  });
export type OnboardingResearchTelemetryEvent = z.infer<
  typeof onboardingResearchTelemetryEventSchema
>;

export type WireEventMap = {
  llm_usage: LlmUsageTelemetryEvent;
  turn: TurnTelemetryEvent;
  lifecycle: LifecycleTelemetryEvent;
  onboarding: OnboardingTelemetryEvent;
  auth_fallback: AuthFallbackTelemetryEvent;
  tool_executed: ToolExecutedTelemetryEvent;
  skill_loaded: SkillLoadedTelemetryEvent;
  watchdog: WatchdogTelemetryEvent;
  config_setting: ConfigSettingTelemetryEvent;
  onboarding_research: OnboardingResearchTelemetryEvent;
};

export const telemetryEventSchema = z.discriminatedUnion("type", [
  llmUsageTelemetryEventSchema,
  turnTelemetryEventSchema,
  lifecycleTelemetryEventSchema,
  onboardingTelemetryEventSchema,
  authFallbackTelemetryEventSchema,
  toolExecutedTelemetryEventSchema,
  skillLoadedTelemetryEventSchema,
  watchdogTelemetryEventSchema,
  configSettingTelemetryEventSchema,
  onboardingResearchTelemetryEventSchema,
]);
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

// Event types recorded SERVER-SIDE by the platform. A daemon-sent
// event of one of these types is rejected (dropped) by ingest.
export const PLATFORM_MANAGED_EVENT_TYPES = ["plugin_installed"] as const;

export const MAX_EVENTS_PER_BATCH = 10000;

export const telemetryIngestRequestSchema = z
  .object({
    device_id: z.string().trim().min(1).max(255).optional(),
    installation_id: z.string().trim().min(1).max(255).optional(),
    assistant_version: z.string().trim().min(1).max(64).nullable().optional(),
    // The server tolerates unknown event types (it skips them); this
    // schema describes what a current daemon should construct.
    events: z.array(telemetryEventSchema).max(MAX_EVENTS_PER_BATCH),
  })
  .superRefine((val, ctx) => {
    if (!val.device_id && !val.installation_id) {
      ctx.addIssue({
        code: "custom",
        message: "Either 'device_id' or 'installation_id' is required.",
      });
    }
  });
export type TelemetryIngestRequest = z.infer<
  typeof telemetryIngestRequestSchema
>;

export const telemetryIngestResponseSchema = z.object({
  accepted: z.number().int(),
  persisted: z.number().int(),
  dropped: z.record(z.string(), jsonValueSchema),
});
export type TelemetryIngestResponse = z.infer<
  typeof telemetryIngestResponseSchema
>;

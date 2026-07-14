/**
 * Shared sample telemetry events for the wire-contract test suites
 * (`types.test.ts` and `telemetry-wire-validation.test.ts`).
 *
 * `wireEventSamples` holds exactly one daemon-typed, wire-valid sample per
 * generated wire event type — when the wire contract gains an event type,
 * add its sample here and both suites pick it up. The daemon-type
 * annotations are themselves part of the contract test: they compile-check
 * that realistic daemon values inhabit the hand-written override types.
 *
 * Imported by `*.test.ts` files only — never by the test preload — so
 * importing daemon types from `src/` is safe (AGENTS.md "Test machinery
 * isolation" scopes its no-`src/` rule to preload-time machinery). The
 * imports are type-only; this module has no runtime side effects.
 */
import type {
  AuthFallbackTelemetryEvent,
  ConfigSettingTelemetryEvent,
  LifecycleTelemetryEvent,
  LlmUsageTelemetryEvent,
  OnboardingResearchTelemetryEvent,
  OnboardingTelemetryEvent,
  SkillLoadedTelemetryEvent,
  ToolExecutedTelemetryEvent,
  TurnTelemetryEvent,
  TurnTrace,
  WatchdogTelemetryEvent,
} from "../types.js";

const RECORDED_AT = 1_750_000_000_000;

const llmUsage: LlmUsageTelemetryEvent = {
  type: "llm_usage",
  daemon_event_id: "evt-llm-usage-001",
  recorded_at: RECORDED_AT,
  assistant_version: "1.2.3",
  conversation_id: "conv-xyz",
  conversation_type: "standard",
  // Zero is legitimate here (wire bound is min(0)) — the wire schema must
  // not reject it.
  turn_index: 0,
  provider: "anthropic",
  model: "claude-fable-5",
  input_tokens: 1200,
  output_tokens: 340,
  cache_creation_input_tokens: 256,
  cache_read_input_tokens: 1024,
  llm_call_count: 3,
  raw_usage: {
    input_tokens: 1200,
    cache_creation: { ephemeral_5m_input_tokens: 256 },
  },
  actor: "user",
  llm_call_site: "mainAgent",
  inference_profile: "balanced",
  inference_profile_source: "active",
  cost: 0.0123,
};

const trace: TurnTrace = {
  schema_version: 3,
  messages: [
    {
      id: "msg-1",
      role: "user",
      created_at: RECORDED_AT - 5_000,
      content: [{ type: "text", text: "What's on my calendar today?" }],
      model: null,
    },
    {
      id: "msg-2",
      role: "assistant",
      created_at: RECORDED_AT - 1_000,
      content: [{ type: "text", text: "You have two meetings." }],
      model: "claude-fable-5",
    },
  ],
  tool_calls: [
    {
      id: "inv-1",
      tool_name: "bash",
      input: { command: "ls" },
      result: "ok",
      decision: "allow",
      duration_ms: 42,
      created_at: RECORDED_AT - 3_000,
    },
  ],
  system_prompt: "You are a helpful assistant.",
  tool_definitions: [
    {
      name: "bash",
      description: "Run a shell command",
      input_schema: { type: "object", properties: {} },
    },
  ],
};

/** Exported separately: both suites build negative `client`-bag cases on it. */
export const turnEventSample: TurnTelemetryEvent = {
  type: "turn",
  daemon_event_id: "evt-turn-001",
  recorded_at: RECORDED_AT,
  assistant_version: "1.2.3",
  conversation_id: "conv-xyz",
  conversation_type: "standard",
  turn_index: 1,
  interface_id: "web",
  channel_id: "vellum",
  client: {
    browser_family: "chrome",
    browser_version: "124",
    os: "macos",
    interface_version: "0.8.2",
  },
  outcome: "failed",
  failure_code: "PROVIDER_RATE_LIMIT",
  trace,
};

const lifecycle: LifecycleTelemetryEvent = {
  type: "lifecycle",
  daemon_event_id: "evt-lifecycle-001",
  recorded_at: RECORDED_AT,
  assistant_version: "1.2.3",
  event_name: "app_open",
};

const onboarding: OnboardingTelemetryEvent = {
  type: "onboarding",
  daemon_event_id: "evt-onboarding-001",
  recorded_at: RECORDED_AT,
  assistant_version: "1.2.3",
  screen: "tools",
  tools: ["gmail", "calendar"],
  tasks: ["email-triage"],
  tone: "friendly",
  google_connected: true,
  google_scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  ab_variant: "control",
  session_id: "sess-123",
  step_name: "select-tools",
  step_index: 2,
  completed_at: "2026-07-13T00:00:00Z",
  funnel_version: "v2",
  user_id: "user-123",
};

const authFallback: AuthFallbackTelemetryEvent = {
  type: "auth_fallback",
  daemon_event_id: "evt-auth-fallback-001",
  recorded_at: RECORDED_AT,
  assistant_version: "1.2.3",
  guard: "edge",
  path: "/v1/conversations",
  failure_kind: "missing_authorization",
  count: 7,
  window_start: RECORDED_AT - 300_000,
  window_end: RECORDED_AT,
};

const toolExecuted: ToolExecutedTelemetryEvent = {
  type: "tool_executed",
  daemon_event_id: "evt-tool-executed-001",
  recorded_at: RECORDED_AT,
  assistant_version: "1.2.3",
  provider: "anthropic",
  model: "claude-fable-5",
  inference_profile: "balanced",
  inference_profile_source: "call_site",
  tool_name: "bash",
  status: "fulfilled",
  duration_ms: 42,
  arg_bytes: 128,
  result_bytes: 2048,
  conversation_id: "conv-xyz",
};

const skillLoaded: SkillLoadedTelemetryEvent = {
  type: "skill_loaded",
  daemon_event_id: "evt-skill-loaded-001",
  recorded_at: RECORDED_AT,
  assistant_version: "1.2.3",
  provider: "anthropic",
  model: "claude-fable-5",
  inference_profile: "balanced",
  inference_profile_source: "conversation",
  skill_name: "plugin-builder",
  skill_updated_at: "2026-06-01T00:00:00Z",
  conversation_id: "conv-xyz",
};

const watchdog: WatchdogTelemetryEvent = {
  type: "watchdog",
  daemon_event_id: "evt-watchdog-001",
  recorded_at: RECORDED_AT,
  assistant_version: "1.2.3",
  check_name: "event_loop_blocked",
  value: 1200,
  detail: { reason: "gc", blocked_ms: 1200 },
};

const configSetting: ConfigSettingTelemetryEvent = {
  type: "config_setting",
  daemon_event_id: "evt-config-setting-001",
  recorded_at: RECORDED_AT,
  assistant_version: "1.2.3",
  config_key: "memory.enabled",
  config_value: "true",
};

/**
 * `onboarding_research` sample. The daemon's type is richer than the wire
 * (structured `claims`/`suggestions`, closed `status`), so it is an `Overrides`
 * entry; the wire schema (opaque JSON arrays, size-bounded) still accepts it.
 */
export const onboardingResearch: OnboardingResearchTelemetryEvent = {
  type: "onboarding_research",
  daemon_event_id: "evt-onboarding-research-1",
  recorded_at: RECORDED_AT,
  assistant_version: "1.2.3",
  conversation_id: "conv-xyz",
  status: "done",
  claims: [
    {
      claim: "Works on developer tooling",
      confidence: "confident",
      sources: ["https://example.com/profile"],
    },
  ],
  claim_count: 1,
  claims_confident: 1,
  claims_maybe: 0,
  claims_guessing: 0,
  suggestions: [
    {
      suggestion: "Set up email triage",
      prompt: "Help me triage my inbox",
    },
  ],
  suggestion_count: 1,
  plugins: ["gmail"],
  installed_plugins: ["gmail", "calendar"],
};

/** One daemon-typed, wire-valid sample per generated wire event type. */
export const wireEventSamples = [
  llmUsage,
  turnEventSample,
  lifecycle,
  onboarding,
  authFallback,
  toolExecuted,
  skillLoaded,
  watchdog,
  configSetting,
  onboardingResearch,
] as const;

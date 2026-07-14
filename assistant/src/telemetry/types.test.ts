import { describe, expect, test } from "bun:test";

import { telemetryEventSchema } from "./telemetry-wire.generated.js";
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
} from "./types.js";

// Runtime contract test: events constructed with the daemon's types must
// parse against the generated wire schemas — the same validation the
// platform's ingest serializers apply. A daemon type whose values can't
// round-trip through `telemetryEventSchema` produces events the server
// silently drops.

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

const turn: TurnTelemetryEvent = {
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

describe("daemon telemetry types against the wire contract", () => {
  const wireSamples = [
    llmUsage,
    turn,
    lifecycle,
    onboarding,
    authFallback,
    toolExecuted,
    skillLoaded,
    watchdog,
    configSetting,
  ] as const;

  for (const sample of wireSamples) {
    test(`daemon-typed ${sample.type} event parses against the wire schema`, () => {
      const result = telemetryEventSchema.safeParse(sample);
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
    });
  }

  test("turn client bag with a nested value fails the wire superRefine", () => {
    // Structurally valid for the daemon's `TurnTelemetryClientInfo` (extra
    // properties are allowed outside fresh-literal checks), but the wire
    // schema mirrors the server's validate_client: nested objects in the
    // `client` bag reject the event at ingest.
    const nestedClient = { os: "macos", screen: { width: 1512, height: 982 } };
    const invalidTurn: TurnTelemetryEvent = { ...turn, client: nestedClient };
    const result = telemetryEventSchema.safeParse(invalidTurn);
    expect(result.success).toBe(false);
  });

  test("onboarding_research is not in the wire contract — the server drops it", () => {
    // Documents the extension gap: `onboarding_research` is daemon-only and
    // has no platform ingest serializer, so the server silently drops these
    // events. The platform-repo follow-up (serializer + Terraform + dbt)
    // closes this; until then the schema rejects the unknown discriminator.
    const onboardingResearch: OnboardingResearchTelemetryEvent = {
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
    const result = telemetryEventSchema.safeParse(onboardingResearch);
    expect(result.success).toBe(false);
  });
});

/**
 * Tests for pre-flush telemetry wire validation.
 *
 * Validation is observability only — it must count and warn, never mutate,
 * filter, or block — and its warn payloads must carry the event type and
 * issue `{ path, code }` shapes only, never field values. `daemon_event_id`
 * is a field value too: activation-funnel ids embed the onboarding session
 * id (traces/claims can hold PII).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Logger } from "pino";

import { telemetryEventSchema } from "./telemetry-wire.generated.js";
import {
  resetUnknownTypeWarningsForTests,
  validateWireEvents,
  wireSchemaByType,
} from "./telemetry-wire-validation.js";

let warnCalls: unknown[][] = [];
const stubLog = {
  warn: (...args: unknown[]) => {
    warnCalls.push(args);
  },
} as unknown as Logger;

/** One wire-valid sample per generated event type. */
const validEvents = [
  {
    type: "llm_usage",
    daemon_event_id: "llm-1",
    recorded_at: 1_700_000_000_000,
    assistant_version: "1.2.3",
    provider: "anthropic",
    model: "claude-fable-5",
    llm_call_site: "mainAgent",
    inference_profile: "balanced",
    inference_profile_source: "active",
    input_tokens: 1200,
    output_tokens: 80,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 900,
    raw_usage: { input_tokens: 1200, output_tokens: 80 },
    actor: "assistant",
    cost: 0.0042,
    conversation_id: "conv-1",
    conversation_type: "standard",
    turn_index: 0,
    llm_call_count: 2,
  },
  {
    type: "turn",
    daemon_event_id: "turn-1",
    recorded_at: 1_700_000_000_001,
    assistant_version: "1.2.3",
    conversation_type: "standard",
    conversation_id: "conv-1",
    turn_index: 1,
    interface_id: "web",
    channel_id: "vellum",
    client: { os: "macos", interface_version: "0.8.2" },
    outcome: "failed",
    failure_code: "PROVIDER_RATE_LIMIT",
    trace: null,
  },
  {
    type: "lifecycle",
    daemon_event_id: "life-1",
    recorded_at: 1_700_000_000_002,
    assistant_version: "1.2.3",
    event_name: "app_open",
  },
  {
    type: "onboarding",
    daemon_event_id: "onb-1",
    recorded_at: 1_700_000_000_003,
    assistant_version: "1.2.3",
    screen: "welcome",
    tools: ["calendar"],
    google_connected: true,
  },
  {
    type: "auth_fallback",
    daemon_event_id: "auth-1",
    recorded_at: 1_700_000_000_004,
    assistant_version: "1.2.3",
    guard: "edge",
    failure_kind: "missing_authorization",
    path: "/v1/conversations",
    count: 3,
    window_start: 1_700_000_000_000,
    window_end: 1_700_000_300_000,
  },
  {
    type: "tool_executed",
    daemon_event_id: "tool-1",
    recorded_at: 1_700_000_000_005,
    assistant_version: "1.2.3",
    provider: "anthropic",
    model: "claude-fable-5",
    inference_profile: null,
    inference_profile_source: null,
    tool_name: "bash",
    status: "fulfilled",
    duration_ms: 120,
    arg_bytes: 64,
    result_bytes: 512,
    conversation_id: "conv-1",
  },
  {
    type: "skill_loaded",
    daemon_event_id: "skill-1",
    recorded_at: 1_700_000_000_006,
    assistant_version: "1.2.3",
    provider: null,
    model: null,
    inference_profile: null,
    inference_profile_source: null,
    skill_name: "plugin-builder",
    skill_updated_at: "2026-07-01T00:00:00Z",
    conversation_id: null,
  },
  {
    type: "watchdog",
    daemon_event_id: "watch-1",
    recorded_at: 1_700_000_000_007,
    assistant_version: "1.2.3",
    check_name: "event_loop_blocked",
    value: 1500,
    detail: { threshold_ms: 1000 },
  },
  {
    type: "config_setting",
    daemon_event_id: "conf-1",
    recorded_at: 1_700_000_000_008,
    assistant_version: "1.2.3",
    config_key: "memory.enabled",
    config_value: "true",
  },
];

function makeOnboardingResearchEvent() {
  return {
    type: "onboarding_research",
    daemon_event_id: "research-1",
    recorded_at: 1_700_000_000_009,
    assistant_version: "1.2.3",
    conversation_id: "conv-1",
    status: "done",
    claims: [],
    claim_count: 0,
    claims_confident: 0,
    claims_maybe: 0,
    claims_guessing: 0,
    suggestions: [],
    suggestion_count: 0,
    plugins: [],
    installed_plugins: [],
  };
}

describe("validateWireEvents", () => {
  beforeEach(() => {
    warnCalls = [];
    resetUnknownTypeWarningsForTests();
  });

  test("a valid event of each wire type passes with no warnings", () => {
    const result = validateWireEvents(validEvents, stubLog);
    expect(result).toEqual({ checked: 9, invalid: 0, unknownTypes: [] });
    expect(warnCalls).toHaveLength(0);
  });

  test("invalid events are counted and warned with {path, code} issues and no field values", () => {
    const sentinel = "SENTINEL_PII_VALUE_do_not_log";
    const invalidTurn = {
      type: "turn",
      daemon_event_id: "turn-bad",
      recorded_at: 1_700_000_000_010,
      assistant_version: "1.2.3",
      conversation_id: "conv-1",
      turn_index: 1,
      // Nested object values violate the wire contract's client bounds; the
      // sentinel must never appear in any warn payload.
      client: { nested: { secret: sentinel } },
    };
    const invalidLifecycle = {
      type: "lifecycle",
      // Mirrors the activation-funnel id shape (`version:sessionId:step`),
      // which embeds the onboarding session id and exceeds the wire schema's
      // 36-char daemon_event_id bound — the id itself must never be logged.
      daemon_event_id: `activation_v1_2026_06:${sentinel}:activation_moment_1_complete`,
      recorded_at: 1_700_000_000_011,
      assistant_version: sentinel,
      // event_name is missing.
    };

    const result = validateWireEvents([invalidTurn, invalidLifecycle], stubLog);
    expect(result).toEqual({ checked: 2, invalid: 2, unknownTypes: [] });
    expect(warnCalls).toHaveLength(2);

    for (const call of warnCalls) {
      const bag = call[0] as {
        eventType: string;
        issues: Array<Record<string, unknown>>;
      };
      // The bag carries the event type and issues only — no daemon_event_id
      // (it is a payload value; activation ids embed the session id).
      expect(Object.keys(bag).sort()).toEqual(["eventType", "issues"]);
      expect(bag.issues.length).toBeGreaterThan(0);
      for (const issue of bag.issues) {
        // Issues carry path + code only — never messages or field values.
        expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
        expect(issue.path).toBeString();
        expect(issue.code).toBeString();
      }
    }
    expect(
      (warnCalls[0][0] as { issues: Array<{ path: string }> }).issues[0].path,
    ).toStartWith("client");
    const lifecyclePaths = (
      warnCalls[1][0] as { issues: Array<{ path: string }> }
    ).issues.map((issue) => issue.path);
    expect(lifecyclePaths).toContain("daemon_event_id");
    expect(lifecyclePaths).toContain("event_name");

    // The planted sentinel (a field value) must be absent from all log args.
    expect(JSON.stringify(warnCalls)).not.toInclude(sentinel);
  });

  test("unknown event types are reported and warned once per process per type", () => {
    const first = validateWireEvents([makeOnboardingResearchEvent()], stubLog);
    const second = validateWireEvents([makeOnboardingResearchEvent()], stubLog);

    expect(first).toEqual({
      checked: 0,
      invalid: 0,
      unknownTypes: ["onboarding_research"],
    });
    expect(second.unknownTypes).toEqual(["onboarding_research"]);

    // Rate-limited: the warn fires exactly once across both calls.
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][0]).toEqual({ eventType: "onboarding_research" });
  });

  test("schema map covers every discriminator of the generated union", () => {
    const discriminators = telemetryEventSchema.options.map(
      (option) => option.shape.type.value,
    );
    expect(new Set(wireSchemaByType.keys())).toEqual(new Set(discriminators));
    expect(discriminators.length).toBeGreaterThanOrEqual(9);
  });
});

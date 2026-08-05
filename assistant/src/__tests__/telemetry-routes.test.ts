import { beforeEach, describe, expect, test } from "bun:test";

import { ACTOR_PRINCIPALS } from "../runtime/auth/route-policy.js";
import { RouteError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/telemetry-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import {
  pendingOutboxPayloads,
  resetOutboxTable,
  setShareAnalytics,
  setShareDiagnostics,
} from "../telemetry/__tests__/outbox-test-harness.js";
import type { OnboardingResearchTelemetryEvent } from "../telemetry/types.js";

function pendingPayloads(): OnboardingResearchTelemetryEvent[] {
  return pendingOutboxPayloads<OnboardingResearchTelemetryEvent>(
    "onboarding_research",
  );
}

const route = ROUTES.find((r) => r.operationId === "telemetry_ingest");

function call(body: unknown) {
  if (!route) {
    throw new Error("route not found");
  }
  return route.handler({ body } as RouteHandlerArgs);
}

/** Well-formed onboarding_research `fields` (base fields stamped by the daemon). */
const VALID_FIELDS = {
  conversation_id: "conv-xyz",
  status: "done",
  self_reported_occupation: "engineer",
  claims: [{ claim: "Senior engineer", confidence: "confident", sources: [] }],
  claim_count: 1,
  claims_confident: 1,
  claims_maybe: 0,
  claims_guessing: 0,
  suggestions: [
    { suggestion: "I'll find 3 papers", prompt: "Find me 3 papers" },
  ],
  suggestion_count: 1,
  plugins: ["marketing-expert"],
  installed_plugins: ["marketing-expert", "web-research"],
};

const VALID_BODY = {
  type: "onboarding_research",
  fields: VALID_FIELDS,
};

describe("telemetry-routes: ingest", () => {
  beforeEach(() => {
    setShareAnalytics(true);
    setShareDiagnostics(true);
    resetOutboxTable();
  });

  test("route policy matches the other client-facing telemetry routes", () => {
    expect(route).toBeDefined();
    expect(route?.endpoint).toBe("telemetry/ingest");
    expect(route?.method).toBe("POST");
    expect(route?.policy?.allowedPrincipalTypes).toEqual(ACTOR_PRINCIPALS);
    expect(route?.policy?.requiredScopes).toEqual(["settings.write"]);
  });

  test("valid body is persisted to the outbox as a wire event", () => {
    const result = call(VALID_BODY);
    expect(result).toEqual({ id: expect.any(String) });

    const payloads = pendingPayloads();
    expect(payloads.length).toBe(1);
    expect(payloads[0]).toMatchObject({
      type: "onboarding_research",
      conversation_id: "conv-xyz",
      status: "done",
      claim_count: 1,
      claims_confident: 1,
      suggestion_count: 1,
      plugins: ["marketing-expert"],
      installed_plugins: ["marketing-expert", "web-research"],
    });
    // Base fields are stamped by the daemon, not the client.
    expect(payloads[0]?.daemon_event_id).toEqual(expect.any(String));
    expect(payloads[0]?.recorded_at).toEqual(expect.any(Number));
    expect(payloads[0]?.assistant_version).toEqual(expect.any(String));
  });

  test("stamps a fresh daemon_event_id by default", () => {
    call(VALID_BODY);
    // No override → the collapse key falls back to the row id (a uuid), not the
    // conversation-scoped key.
    expect(pendingPayloads()[0]?.daemon_event_id).not.toBe(
      "onboarding_research:conv-xyz",
    );
  });

  test("honors a client-supplied daemon_event_id collapse key", () => {
    call({ ...VALID_BODY, daemon_event_id: "onboarding_research:conv-xyz" });
    expect(pendingPayloads()[0]?.daemon_event_id).toBe(
      "onboarding_research:conv-xyz",
    );
  });

  test("accepts the duration-metric start event", () => {
    // The onboarding research duration metric is a PAIR of events — the start
    // and the terminal report — with duration read as the gap between their
    // daemon-stamped `recorded_at`s. The start half carries `status: "started"`
    // and empty result fields, a shape nothing else exercises.
    //
    // This guards a silent failure mode: `status` is a free-form string on the
    // wire today, and the client depends on that. Were the platform to tighten
    // it to an enum of the terminal values, every start event would 400 and the
    // metric would go quiet with no other signal. Then this test goes red on
    // the wire-sync PR instead.
    const result = call({
      type: "onboarding_research",
      daemon_event_id: "onboarding_research:started:conv-xyz",
      fields: {
        conversation_id: "conv-xyz",
        status: "started",
        self_reported_occupation: "engineer",
        claims: [],
        claim_count: 0,
        claims_confident: 0,
        claims_maybe: 0,
        claims_guessing: 0,
        suggestions: [],
        suggestion_count: 0,
        plugins: [],
        installed_plugins: [],
      },
    });
    expect(result).toEqual({ id: expect.any(String) });

    const payloads = pendingPayloads();
    expect(payloads.length).toBe(1);
    expect(payloads[0]).toMatchObject({
      status: "started",
      conversation_id: "conv-xyz",
      claim_count: 0,
    });
    // The start's collapse key must differ from the terminal report's, or the
    // pair dedups down to one event and the duration is unrecoverable.
    expect(payloads[0]?.daemon_event_id).toBe(
      "onboarding_research:started:conv-xyz",
    );
    expect(payloads[0]?.daemon_event_id).not.toBe(
      "onboarding_research:conv-xyz",
    );
    // Daemon-stamped, so the subtraction never depends on the browser clock.
    expect(payloads[0]?.recorded_at).toEqual(expect.any(Number));
  });

  test("returns skipped and persists nothing under the analytics opt-out", () => {
    setShareAnalytics(false);
    expect(call(VALID_BODY)).toEqual({ skipped: true });
    expect(pendingPayloads().length).toBe(0);
  });

  test("persists regardless of the diagnostics opt-out (rides analytics only)", () => {
    setShareDiagnostics(false, "2000-01-01");
    expect(call(VALID_BODY)).toEqual({ id: expect.any(String) });
    expect(pendingPayloads().length).toBe(1);
  });

  test("rejects a non-outbox (watermark) or unknown type", () => {
    // `turn` is a real wire type but watermark-flushed, not outbox-backed, so it
    // has no ingest variant and a client can't inject it.
    expect(() => call({ type: "turn", fields: {} })).toThrow(RouteError);
    // An unknown type is rejected the same way.
    expect(() => call({ type: "not_a_type", fields: {} })).toThrow(RouteError);
    expect(pendingPayloads().length).toBe(0);
  });

  test("accepts any outbox-backed type, e.g. config_setting", () => {
    const result = call({
      type: "config_setting",
      fields: { config_key: "voice.provider", config_value: "elevenlabs" },
    });
    expect(result).toEqual({ id: expect.any(String) });

    const payloads = pendingOutboxPayloads<{ config_key: string }>(
      "config_setting",
    );
    expect(payloads.length).toBe(1);
    expect(payloads[0]).toMatchObject({
      type: "config_setting",
      config_key: "voice.provider",
      config_value: "elevenlabs",
    });
  });

  test("rejects malformed fields (missing or mistyped) without persisting", () => {
    // Missing the required derived counts.
    const {
      claim_count: _c,
      suggestion_count: _s,
      ...missingCounts
    } = VALID_FIELDS;
    expect(() =>
      call({ type: "onboarding_research", fields: missingCounts }),
    ).toThrow(RouteError);

    // Wrong type for a numeric field.
    expect(() =>
      call({
        type: "onboarding_research",
        fields: { ...VALID_FIELDS, claim_count: "one" },
      }),
    ).toThrow(RouteError);

    expect(pendingPayloads().length).toBe(0);
  });

  test("rejects a structurally invalid request body", () => {
    expect(() => call({ type: "onboarding_research" })).toThrow(RouteError);
    expect(() => call({ fields: VALID_FIELDS })).toThrow(RouteError);
    expect(pendingPayloads().length).toBe(0);
  });

  test("strips unknown fields keys (typed schema, not a passthrough record)", () => {
    call({
      type: "onboarding_research",
      fields: { ...VALID_FIELDS, bogus_extra: "nope" },
    });
    const payloads = pendingPayloads();
    expect(payloads.length).toBe(1);
    expect(payloads[0]).not.toHaveProperty("bogus_extra");
  });
});

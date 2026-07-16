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
  suggestions: [{ suggestion: "I'll find 3 papers", prompt: "Find me 3 papers" }],
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

  test("rejects a type not on the client-reportable allowlist", () => {
    // `turn` is a real wire type but daemon-authoritative — a client must never
    // be able to inject it.
    expect(() => call({ type: "turn", fields: {} })).toThrow(RouteError);
    // An unknown type is rejected the same way.
    expect(() => call({ type: "not_a_type", fields: {} })).toThrow(RouteError);
    expect(pendingPayloads().length).toBe(0);
  });

  test("rejects a payload that fails the wire schema without persisting", () => {
    // Missing the required derived counts.
    const { claim_count: _c, suggestion_count: _s, ...missingCounts } =
      VALID_FIELDS;
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
});

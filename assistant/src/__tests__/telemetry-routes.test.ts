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

const route = ROUTES.find(
  (r) => r.operationId === "telemetry_onboarding_research",
);

function call(body: unknown) {
  if (!route) {
    throw new Error("route not found");
  }
  return route.handler({ body } as RouteHandlerArgs);
}

const VALID_BODY = {
  conversation_id: "conv-xyz",
  status: "done",
  claims: [{ claim: "Senior engineer", confidence: "confident", sources: [] }],
  suggestions: [
    { suggestion: "I'll find 3 papers", prompt: "Find me 3 papers" },
  ],
  plugins: ["marketing-expert"],
  installed_plugins: ["marketing-expert", "web-research"],
};

describe("telemetry-routes: onboarding-research", () => {
  beforeEach(() => {
    setShareAnalytics(true);
    setShareDiagnostics(true);
    resetOutboxTable();
  });

  test("route policy matches the other client-facing telemetry routes", () => {
    expect(route).toBeDefined();
    expect(route?.endpoint).toBe("telemetry/onboarding-research");
    expect(route?.method).toBe("POST");
    expect(route?.policy?.allowedPrincipalTypes).toEqual(ACTOR_PRINCIPALS);
    expect(route?.policy?.requiredScopes).toEqual(["settings.write"]);
  });

  test("valid body is persisted to the outbox as a wire onboarding_research event", () => {
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
  });

  test("returns skipped and persists nothing under the analytics opt-out", () => {
    setShareAnalytics(false);
    expect(call(VALID_BODY)).toEqual({ skipped: true });
    expect(pendingPayloads().length).toBe(0);
  });

  test("returns skipped and persists nothing under the diagnostics opt-out", () => {
    setShareDiagnostics(false);
    expect(call(VALID_BODY)).toEqual({ skipped: true });
    expect(pendingPayloads().length).toBe(0);
  });

  test("rejects a malformed body without persisting", () => {
    expect(() => call({ ...VALID_BODY, status: "not-a-status" })).toThrow(
      RouteError,
    );
    expect(() => call({ ...VALID_BODY, claims: [{ claim: "x" }] })).toThrow(
      RouteError,
    );
    expect(pendingPayloads().length).toBe(0);
  });
});

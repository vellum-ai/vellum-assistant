/**
 * Unit tests for the suggest_trust_rule route handler.
 *
 * The handler delegates to the shared `runOneShotLLM` helper (tool mode +
 * zod schema + timeout). These tests mock that helper to exercise the
 * handler's result-status → RouteError mapping and response shaping:
 * - ok: validated tool input → correct SuggestTrustRuleResponse
 * - unavailable: no provider → ServiceUnavailableError (503)
 * - failure: unusable output → BadGatewayError (502)
 * - directoryScopeOptions is optional: passes through correctly when absent
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { BadGatewayError, ServiceUnavailableError } from "../errors.js";

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

type OneShotResult =
  | { status: "ok"; data: Record<string, unknown>; response: unknown }
  | { status: "unavailable" }
  | { status: "failure"; reason: string; response?: unknown };

let mockResult: OneShotResult = {
  status: "ok",
  data: {
    pattern: "rm -rf *",
    risk: "high",
    scope: "/workspace/myproject/*",
    description: "Any recursive removal",
  },
  response: { model: "test-model" },
};

const runOneShotLLMSpy = mock(async () => mockResult);

mock.module("../../../providers/one-shot-llm.js", () => ({
  runOneShotLLM: runOneShotLLMSpy,
}));

mock.module("../../../providers/provider-send-message.js", () => ({
  userMessage: (text: string) => ({ role: "user", content: text }),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { ROUTES } from "../suggest-trust-rule-routes.js";

const suggestTrustRuleRoute = ROUTES[0];

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const baseScopeOptions = [
  { pattern: "rm -rf ./dist", label: "exact match" },
  { pattern: "rm -rf *", label: "any recursive removal" },
  { pattern: "rm **", label: "any rm invocation" },
];

const baseDirectoryScopeOptions = [
  { scope: "/workspace/myproject/dist", label: "exact directory" },
  { scope: "/workspace/myproject/*", label: "project files" },
  { scope: "everywhere", label: "everywhere" },
];

const baseRequest = {
  tool: "bash",
  command: "rm -rf ./dist",
  riskAssessment: {
    risk: "high",
    reasoning: "destructive",
    reasonDescription: "destructive recursive deletion",
  },
  scopeOptions: baseScopeOptions,
  directoryScopeOptions: baseDirectoryScopeOptions,
  currentThreshold: "medium",
  intent: "auto_approve" as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("suggestTrustRuleRoute", () => {
  beforeEach(() => {
    runOneShotLLMSpy.mockClear();
    mockResult = {
      status: "ok",
      data: {
        pattern: "rm -rf *",
        risk: "high",
        scope: "/workspace/myproject/*",
        description: "Any recursive removal",
      },
      response: { model: "test-model" },
    };
  });

  test("route operationId is 'suggest_trust_rule'", () => {
    expect(suggestTrustRuleRoute.operationId).toBe("suggest_trust_rule");
  });

  describe("happy path", () => {
    test("returns correct SuggestTrustRuleResponse shape with scopeOptions and directoryScopeOptions passed through", async () => {
      const result = await suggestTrustRuleRoute.handler({
        body: baseRequest as unknown as Record<string, unknown>,
      });

      expect(result).toMatchObject({
        pattern: "rm -rf *",
        risk: "high",
        scope: "/workspace/myproject/*",
        description: "Any recursive removal",
        scopeOptions: baseScopeOptions,
        directoryScopeOptions: baseDirectoryScopeOptions,
      });
    });

    test("invokes runOneShotLLM with the trustRuleSuggestion call site and forced tool", async () => {
      await suggestTrustRuleRoute.handler({
        body: baseRequest as unknown as Record<string, unknown>,
      });

      expect(runOneShotLLMSpy).toHaveBeenCalledTimes(1);
      const callArgs = runOneShotLLMSpy.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe("trustRuleSuggestion");
      const opts = callArgs[2] as {
        tools: { name: string }[];
        toolChoice: string;
        schema: unknown;
      };
      expect(opts.toolChoice).toBe("suggest_trust_rule");
      expect(opts.tools[0]?.name).toBe("suggest_trust_rule");
      expect(opts.schema).toBeDefined();
    });
  });

  describe("no provider", () => {
    test("throws ServiceUnavailableError (503) when the helper reports unavailable", async () => {
      mockResult = { status: "unavailable" };

      const promise = suggestTrustRuleRoute.handler({
        body: baseRequest as unknown as Record<string, unknown>,
      });
      await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableError);
      await expect(promise).rejects.toMatchObject({ statusCode: 503 });
    });
  });

  describe("unusable LLM output", () => {
    test("throws BadGatewayError (502) when the helper reports a failure", async () => {
      mockResult = {
        status: "failure",
        reason: "tool_use_missing",
        response: { model: "test-model" },
      };

      const promise = suggestTrustRuleRoute.handler({
        body: baseRequest as unknown as Record<string, unknown>,
      });
      await expect(promise).rejects.toBeInstanceOf(BadGatewayError);
      await expect(promise).rejects.toMatchObject({ statusCode: 502 });
    });
  });

  describe("optional directoryScopeOptions", () => {
    test("passes through correctly when directoryScopeOptions is absent", async () => {
      const requestWithoutDirScope = {
        ...baseRequest,
        directoryScopeOptions: undefined,
      };

      const result = await suggestTrustRuleRoute.handler({
        body: requestWithoutDirScope as unknown as Record<string, unknown>,
      });

      expect(result).toMatchObject({
        pattern: "rm -rf *",
        risk: "high",
        scope: "/workspace/myproject/*",
        description: "Any recursive removal",
        scopeOptions: baseScopeOptions,
      });
      expect(
        (result as { directoryScopeOptions?: unknown }).directoryScopeOptions,
      ).toBeUndefined();
    });
  });
});

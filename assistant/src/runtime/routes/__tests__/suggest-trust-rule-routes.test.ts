/**
 * Unit tests for the suggest_trust_rule IPC route handler.
 *
 * Covers:
 * - Happy path: provider returns tool_use block → correct SuggestTrustRuleResponse
 * - No provider: getConfiguredProvider returns null → throws
 * - No tool block: provider returns non-tool response → throws
 * - directoryScopeOptions is optional: passes through correctly when absent
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let mockSendMessage = mock(async () => ({
  content: [
    {
      type: "tool_use",
      id: "tu_1",
      name: "suggest_trust_rule",
      input: {
        pattern: "rm -rf *",
        risk: "high",
        scope: "/workspace/myproject/*",
        description: "Any recursive removal",
      },
    },
  ],
  model: "test-model",
  usage: { inputTokens: 10, outputTokens: 20 },
  stopReason: "tool_use",
}));

let mockProvider: { sendMessage: typeof mockSendMessage } | null = {
  sendMessage: mockSendMessage,
};

let mockExtractToolUseResult: unknown = {
  type: "tool_use",
  id: "tu_1",
  name: "suggest_trust_rule",
  input: {
    pattern: "rm -rf *",
    risk: "high",
    scope: "/workspace/myproject/*",
    description: "Any recursive removal",
  },
};

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => mockProvider,
  createTimeout: () => ({
    signal: new AbortController().signal,
    cleanup: () => {},
  }),
  extractToolUse: () => mockExtractToolUseResult,
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
    mockSendMessage = mock(async () => ({
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "suggest_trust_rule",
          input: {
            pattern: "rm -rf *",
            risk: "high",
            scope: "/workspace/myproject/*",
            description: "Any recursive removal",
          },
        },
      ],
      model: "test-model",
      usage: { inputTokens: 10, outputTokens: 20 },
      stopReason: "tool_use",
    }));
    mockProvider = { sendMessage: mockSendMessage };
    mockExtractToolUseResult = {
      type: "tool_use",
      id: "tu_1",
      name: "suggest_trust_rule",
      input: {
        pattern: "rm -rf *",
        risk: "high",
        scope: "/workspace/myproject/*",
        description: "Any recursive removal",
      },
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

    test("passes callSite 'trustRuleSuggestion' and tool_choice to provider", async () => {
      await suggestTrustRuleRoute.handler({
        body: baseRequest as unknown as Record<string, unknown>,
      });

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const callArgs = mockSendMessage.mock.calls[0] as unknown[];
      const options = callArgs[3] as {
        config: { callSite: string; tool_choice: { type: string; name: string } };
      };
      expect(options.config.callSite).toBe("trustRuleSuggestion");
      expect(options.config.tool_choice).toEqual({
        type: "tool",
        name: "suggest_trust_rule",
      });
    });
  });

  describe("no provider", () => {
    test("throws when getConfiguredProvider returns null", async () => {
      mockProvider = null;

      await expect(
        suggestTrustRuleRoute.handler({
          body: baseRequest as unknown as Record<string, unknown>,
        }),
      ).rejects.toThrow("No LLM provider configured for trustRuleSuggestion");
    });
  });

  describe("no tool block", () => {
    test("throws when extractToolUse returns undefined", async () => {
      mockExtractToolUseResult = undefined;

      await expect(
        suggestTrustRuleRoute.handler({
          body: baseRequest as unknown as Record<string, unknown>,
        }),
      ).rejects.toThrow("No tool_use block in trust rule suggestion response");
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

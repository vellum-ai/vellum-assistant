/**
 * Tests for gateway trust-rule IPC routes.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type ListTrustRulesParams = {
  origin?: string;
  tool?: string;
  includeAll?: boolean;
  includeDeleted?: boolean;
};

const listResult = {
  rules: [
    {
      id: "rule-123",
      tool: "bash",
      pattern: "echo hello",
      risk: "low",
      description: "Allow echo hello",
      origin: "user_defined",
      userModified: false,
      deleted: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const listTrustRulesMock = mock(
  (_params?: ListTrustRulesParams): typeof listResult => listResult,
);

mock.module("../http/routes/trust-rules.js", () => ({
  listTrustRules: listTrustRulesMock,
}));

import { trustRulesRoutes } from "./trust-rules-handlers.js";

beforeEach(() => {
  listTrustRulesMock.mockClear();
});

describe("trustRulesRoutes", () => {
  test("registers trust_rules_list with optional params", () => {
    const route = trustRulesRoutes[0];

    expect(route.method).toBe("trust_rules_list");
    expect(route.schema?.safeParse(undefined).success).toBe(true);
    expect(route.schema?.safeParse({ include_all: "true" }).success).toBe(
      false,
    );
  });

  test("lists trust rules through the IPC handler without writing test data", () => {
    const result = trustRulesRoutes[0].handler({
      tool: "bash",
      origin: "user_defined",
      include_all: true,
      include_deleted: true,
    });

    expect(result).toBe(listResult);
    expect(listTrustRulesMock).toHaveBeenCalledWith({
      origin: "user_defined",
      tool: "bash",
      includeAll: true,
      includeDeleted: true,
    });
  });
});

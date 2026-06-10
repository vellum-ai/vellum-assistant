/**
 * Tests for gateway trust-rule IPC routes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleStore } from "../db/trust-rule-store.js";
import { clearFeatureFlagStoreCache } from "../feature-flag-store.js";
import {
  initTrustRuleCache,
  resetTrustRuleCache,
} from "../risk/trust-rule-cache.js";
import { trustRulesRoutes } from "./trust-rules-handlers.js";
import "../__tests__/test-preload.js";

let store: TrustRuleStore;

beforeEach(async () => {
  resetGatewayDb();
  resetTrustRuleCache();
  clearFeatureFlagStoreCache();
  await initGatewayDb();
  initTrustRuleCache();
  store = new TrustRuleStore();
});

afterEach(() => {
  resetTrustRuleCache();
  clearFeatureFlagStoreCache();
  resetGatewayDb();
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

  test("lists user-relevant rules through the IPC handler", () => {
    store.create({
      tool: "bash",
      pattern: "echo hello",
      risk: "low",
      description: "Allow echo hello",
    });

    const result = trustRulesRoutes[0].handler({
      tool: "bash",
      origin: "user_defined",
    }) as {
      rules: Array<{ tool: string; pattern: string; origin: string }>;
    };

    expect(
      result.rules.some(
        (rule) =>
          rule.tool === "bash" &&
          rule.pattern === "echo hello" &&
          rule.origin === "user_defined",
      ),
    ).toBe(true);
    expect(result.rules.every((rule) => rule.tool === "bash")).toBe(true);
    expect(result.rules.every((rule) => rule.origin === "user_defined")).toBe(
      true,
    );
    expect(
      result.rules.find((rule) => rule.pattern === "echo hello"),
    ).toMatchObject({
      tool: "bash",
      pattern: "echo hello",
      origin: "user_defined",
    });
  });
});

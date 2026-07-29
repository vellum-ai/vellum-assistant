import { describe, test, expect } from "bun:test";
import { LOCAL_ASSISTANT_ID } from "../assistant-id.js";
import {
  hasRoutableIdentity,
  LOCAL_ROUTE,
  resolveAssistantByPhoneNumber,
} from "../routing/resolve-assistant.js";
import type { GatewayConfig } from "../config.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    port: 7830,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

describe("LOCAL_ROUTE", () => {
  test("names the local assistant", () => {
    expect(LOCAL_ROUTE.assistantId).toBe(LOCAL_ASSISTANT_ID);
    expect(LOCAL_ROUTE.routeSource).toBe("default");
  });

  test("is frozen so a caller cannot mutate the shared route", () => {
    expect(Object.isFrozen(LOCAL_ROUTE)).toBe(true);
  });
});

describe("hasRoutableIdentity", () => {
  test("accepts an event with either identity present", () => {
    expect(hasRoutableIdentity("99001", "55001")).toBe(true);
    expect(hasRoutableIdentity("99001", undefined)).toBe(true);
    expect(hasRoutableIdentity(undefined, "55001")).toBe(true);
  });

  test("rejects an event with neither identity", () => {
    // Fail-closed: nothing to bind a conversation on, nothing to classify
    // trust against. Empty strings count as absent.
    for (const [conversationId, actorId] of [
      ["", ""],
      [undefined, undefined],
      ["", undefined],
      [undefined, ""],
    ] as const) {
      expect(hasRoutableIdentity(conversationId, actorId)).toBe(false);
    }
  });
});

describe("resolveAssistantByPhoneNumber", () => {
  const config = makeConfig();

  function cacheWith(mapping: Record<string, string> | undefined) {
    return {
      getRecord: () => mapping,
    } as unknown as Parameters<typeof resolveAssistantByPhoneNumber>[2];
  }

  test("resolves the assistant whose configured number was dialed", () => {
    const result = resolveAssistantByPhoneNumber(
      config,
      "+12015550101",
      cacheWith({ "ast-a": "+12015550101", "ast-b": "+12015550102" }),
    );
    expect(result).toEqual({
      assistantId: "ast-a",
      routeSource: "phone_number",
    });
  });

  test("returns undefined when no configured number matches", () => {
    const result = resolveAssistantByPhoneNumber(
      config,
      "+12015550199",
      cacheWith({ "ast-a": "+12015550101" }),
    );
    expect(result).toBeUndefined();
  });

  test("returns undefined when no mapping is configured", () => {
    expect(
      resolveAssistantByPhoneNumber(
        config,
        "+12015550101",
        cacheWith(undefined),
      ),
    ).toBeUndefined();
  });
});

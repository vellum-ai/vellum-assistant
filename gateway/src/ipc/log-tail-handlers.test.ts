/**
 * Tests for gateway log-tail IPC routes.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GatewayConfig } from "../config.js";

const tailResult = {
  lines: [{ msg: "warn msg", level: 40 }],
  truncated: false,
};

const tailGatewayLogsMock = mock(
  (
    _config: GatewayConfig,
    _params?: Record<string, unknown>,
  ): typeof tailResult => tailResult,
);

mock.module("../http/routes/log-tail.js", () => ({
  tailGatewayLogs: tailGatewayLogsMock,
}));

const { createLogTailRoutes } = await import("./log-tail-handlers.js");

function makeConfig(): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 20 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 100 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1024 * 1024,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    unmappedPolicy: "default",
    trustProxy: false,
  } as GatewayConfig;
}

beforeEach(() => {
  tailGatewayLogsMock.mockClear();
});

describe("createLogTailRoutes", () => {
  test("registers gateway_logs_tail with optional params", () => {
    const route = createLogTailRoutes(makeConfig())[0];

    expect(route.method).toBe("gateway_logs_tail");
    expect(route.schema?.safeParse(undefined).success).toBe(true);
    expect(route.schema?.safeParse({ level: "INVALID" }).success).toBe(false);
  });

  test("tails gateway logs through the IPC handler", () => {
    const config = makeConfig();
    const route = createLogTailRoutes(config)[0];
    const result = route.handler({ n: 2, level: "warn", module: "mcp" });

    expect(result).toBe(tailResult);
    expect(tailGatewayLogsMock).toHaveBeenCalledWith(config, {
      n: 2,
      level: "warn",
      module: "mcp",
    });
  });
});

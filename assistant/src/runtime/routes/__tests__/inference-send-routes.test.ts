/**
 * Tests for the one-shot inference send route (`POST /v1/inference/send`).
 *
 * Focus: the provider call's timeout budget. The handler must honor a
 * caller-supplied `timeoutMs` (the CLI's `--timeout-seconds`), clamp it to a
 * sane ceiling, and fall back to a generous default that matches the CLI's
 * documented 32-minute wait — not the old hard-coded 60s.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must come before imports) ──────────────────────────────────

mock.module("../../../config/loader.js", () => ({
  getConfigReadOnly: () => ({ llm: { profiles: {} } }),
}));

// Capture the ms passed to createTimeout so we can assert the resolved budget.
let lastCreateTimeoutMs: number | undefined;
const sendMessageSpy = mock(async () => ({
  content: [{ type: "text", text: "hello" }],
  model: "stub-model",
  usage: { inputTokens: 1, outputTokens: 2 },
  stopReason: "end_turn",
}));
const getConfiguredProviderSpy = mock(async () => ({
  name: "stub-provider",
  sendMessage: sendMessageSpy,
}));
mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: getConfiguredProviderSpy,
  extractAllText: () => "hello",
  userMessage: (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
  createTimeout: (ms: number) => {
    lastCreateTimeoutMs = ms;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
  },
}));

// ── Real imports (after mocks) ────────────────────────────────────────────────

import { ROUTES } from "../inference-send-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_INFERENCE_TIMEOUT_MS = 32 * 60 * 1000;
const MAX_INFERENCE_TIMEOUT_MS = 35 * 60 * 1000;

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

async function send(body: Record<string, unknown>): Promise<unknown> {
  return await findHandler("inference_send")({ body } as RouteHandlerArgs);
}

beforeEach(() => {
  lastCreateTimeoutMs = undefined;
  sendMessageSpy.mockClear();
  getConfiguredProviderSpy.mockClear();
});

// ── Timeout budget ──────────────────────────────────────────────────────────

describe("inference_send timeout budget", () => {
  test("applies the CLI-matching default when no timeout is supplied", async () => {
    await send({ message: "hi" });
    expect(lastCreateTimeoutMs).toBe(DEFAULT_INFERENCE_TIMEOUT_MS);
  });

  test("honors a caller-supplied timeoutMs under the ceiling", async () => {
    await send({ message: "hi", timeoutMs: 300_000 });
    expect(lastCreateTimeoutMs).toBe(300_000);
  });

  test("clamps a caller-supplied timeoutMs to the ceiling", async () => {
    await send({ message: "hi", timeoutMs: 60 * 60 * 1000 });
    expect(lastCreateTimeoutMs).toBe(MAX_INFERENCE_TIMEOUT_MS);
  });

  test("passes the resulting abort signal to the provider", async () => {
    await send({ message: "hi", timeoutMs: 5_000 });
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const call = sendMessageSpy.mock.calls[0] as unknown as [
      unknown[],
      { signal?: AbortSignal },
    ];
    expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

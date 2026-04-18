/**
 * Integration tests for the `ui_request` IPC route.
 *
 * Exercises the full IPC round-trip: CliIpcServer + cliIpcCall over
 * the Unix domain socket, with mock interactive UI resolvers to verify
 * submit / cancel / timeout, unknown-conversation, and non-interactive
 * failure scenarios.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  InteractiveUiRequest,
  InteractiveUiResult,
} from "../../runtime/interactive-ui.js";
import {
  registerInteractiveUiResolver,
  resetInteractiveUiResolverForTests,
  resetSurfaceIdCounterForTests,
} from "../../runtime/interactive-ui.js";
import { cliIpcCall } from "../cli-client.js";
import { CliIpcServer } from "../cli-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let server: CliIpcServer | null = null;

function baseParams(
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    conversationId: "conv-test-123",
    surfaceType: "confirmation",
    data: { message: "Are you sure?" },
    ...overrides,
  };
}

beforeEach(async () => {
  resetInteractiveUiResolverForTests();
  resetSurfaceIdCounterForTests();
  server = new CliIpcServer();
  server.start();
  // Allow the server socket to bind.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterEach(() => {
  server?.stop();
  server = null;
  resetInteractiveUiResolverForTests();
  resetSurfaceIdCounterForTests();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ui_request IPC route", () => {
  // ── Submit ────────────────────────────────────────────────────────

  test("returns submitted result when user selects an action", async () => {
    registerInteractiveUiResolver(
      async (_req: InteractiveUiRequest): Promise<InteractiveUiResult> => ({
        status: "submitted",
        actionId: "confirm",
        surfaceId: "mock-surface-1",
      }),
    );

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      ...baseParams(),
      actions: [
        { id: "confirm", label: "Yes", variant: "primary" },
        { id: "deny", label: "No", variant: "secondary" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("submitted");
    expect(result.result!.actionId).toBe("confirm");
    expect(result.result!.surfaceId).toBeDefined();
  });

  // ── Cancel ────────────────────────────────────────────────────────

  test("returns cancelled result when user dismisses the surface", async () => {
    registerInteractiveUiResolver(
      async (_req: InteractiveUiRequest): Promise<InteractiveUiResult> => ({
        status: "cancelled",
        surfaceId: "mock-surface-2",
      }),
    );

    const result = await cliIpcCall<InteractiveUiResult>(
      "ui_request",
      baseParams(),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("cancelled");
  });

  // ── Timeout ───────────────────────────────────────────────────────

  test("returns timed_out result when the surface times out", async () => {
    registerInteractiveUiResolver(
      async (_req: InteractiveUiRequest): Promise<InteractiveUiResult> => ({
        status: "timed_out",
        surfaceId: "mock-surface-3",
      }),
    );

    const result = await cliIpcCall<InteractiveUiResult>(
      "ui_request",
      baseParams({ timeoutMs: 1000 }),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("timed_out");
  });

  // ── Unknown conversation (resolver throws) ────────────────────────

  test("returns cancelled with resolver_error reason when resolver throws for unknown conversation", async () => {
    registerInteractiveUiResolver(async (_req: InteractiveUiRequest) => {
      throw new Error("Unknown conversation: conv-nonexistent");
    });

    const result = await cliIpcCall<InteractiveUiResult>(
      "ui_request",
      baseParams({ conversationId: "conv-nonexistent" }),
    );

    // requestInteractiveUi catches resolver errors and fails closed
    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("cancelled");
    expect(result.result!.cancellationReason).toBe("resolver_error");
    expect(result.result!.surfaceId).toBeDefined();
  });

  // ── Non-interactive failure (no resolver registered) ──────────────

  test("returns cancelled with no_interactive_surface reason when no resolver is registered", async () => {
    // No resolver registered — resetInteractiveUiResolverForTests()
    // was called in beforeEach, so the module-level resolver is null.

    const result = await cliIpcCall<InteractiveUiResult>(
      "ui_request",
      baseParams(),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("cancelled");
    expect(result.result!.cancellationReason).toBe("no_interactive_surface");
    expect(result.result!.surfaceId).toBeDefined();
  });

  // ── Schema validation ─────────────────────────────────────────────

  test("rejects missing conversationId", async () => {
    const result = await cliIpcCall("ui_request", {
      surfaceType: "confirmation",
      data: { message: "test" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects empty conversationId", async () => {
    const result = await cliIpcCall("ui_request", {
      conversationId: "",
      surfaceType: "confirmation",
      data: { message: "test" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects invalid surfaceType", async () => {
    const result = await cliIpcCall("ui_request", {
      conversationId: "conv-1",
      surfaceType: "unsupported",
      data: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects missing data field", async () => {
    const result = await cliIpcCall("ui_request", {
      conversationId: "conv-1",
      surfaceType: "confirmation",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects non-positive timeoutMs", async () => {
    const result = await cliIpcCall("ui_request", {
      conversationId: "conv-1",
      surfaceType: "confirmation",
      data: {},
      timeoutMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects non-integer timeoutMs", async () => {
    const result = await cliIpcCall("ui_request", {
      conversationId: "conv-1",
      surfaceType: "confirmation",
      data: {},
      timeoutMs: 1.5,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects action with empty id", async () => {
    const result = await cliIpcCall("ui_request", {
      conversationId: "conv-1",
      surfaceType: "confirmation",
      data: {},
      actions: [{ id: "", label: "OK" }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects action with empty label", async () => {
    const result = await cliIpcCall("ui_request", {
      conversationId: "conv-1",
      surfaceType: "confirmation",
      data: {},
      actions: [{ id: "ok", label: "" }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  // ── Optional fields ───────────────────────────────────────────────

  test("accepts request with optional title", async () => {
    registerInteractiveUiResolver(
      async (req: InteractiveUiRequest): Promise<InteractiveUiResult> => ({
        status: "submitted",
        actionId: "ok",
        surfaceId: "mock-surface-title",
        summary: req.title,
      }),
    );

    const result = await cliIpcCall<InteractiveUiResult>(
      "ui_request",
      baseParams({ title: "Confirm Action" }),
    );

    expect(result.ok).toBe(true);
    expect(result.result!.status).toBe("submitted");
    expect(result.result!.summary).toBe("Confirm Action");
  });

  // ── Cancellation reason round-trip ────────────────────────────────

  test("round-trips user_dismissed cancellation reason from resolver", async () => {
    registerInteractiveUiResolver(
      async (_req: InteractiveUiRequest): Promise<InteractiveUiResult> => ({
        status: "cancelled",
        surfaceId: "mock-surface-dismissed",
        cancellationReason: "user_dismissed",
      }),
    );

    const result = await cliIpcCall<InteractiveUiResult>(
      "ui_request",
      baseParams(),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("cancelled");
    expect(result.result!.cancellationReason).toBe("user_dismissed");
  });

  test("round-trips conversation_not_found cancellation reason from resolver", async () => {
    registerInteractiveUiResolver(
      async (_req: InteractiveUiRequest): Promise<InteractiveUiResult> => ({
        status: "cancelled",
        surfaceId: "mock-surface-not-found",
        cancellationReason: "conversation_not_found",
      }),
    );

    const result = await cliIpcCall<InteractiveUiResult>(
      "ui_request",
      baseParams({ conversationId: "conv-missing" }),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("cancelled");
    expect(result.result!.cancellationReason).toBe("conversation_not_found");
  });

  test("submitted result does not carry cancellationReason through IPC", async () => {
    registerInteractiveUiResolver(
      async (_req: InteractiveUiRequest): Promise<InteractiveUiResult> => ({
        status: "submitted",
        actionId: "confirm",
        surfaceId: "mock-surface-submitted",
      }),
    );

    const result = await cliIpcCall<InteractiveUiResult>(
      "ui_request",
      baseParams(),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("submitted");
    expect(result.result!.cancellationReason).toBeUndefined();
  });

  // ── Optional fields (continued) ────────────────────────────────────

  test("accepts form surfaceType with submittedData", async () => {
    registerInteractiveUiResolver(
      async (_req: InteractiveUiRequest): Promise<InteractiveUiResult> => ({
        status: "submitted",
        submittedData: { name: "Alice", email: "alice@example.com" },
        surfaceId: "mock-surface-form",
      }),
    );

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      conversationId: "conv-form",
      surfaceType: "form",
      data: { fields: [{ name: "name" }, { name: "email" }] },
    });

    expect(result.ok).toBe(true);
    expect(result.result!.status).toBe("submitted");
    expect(result.result!.submittedData).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
  });
});

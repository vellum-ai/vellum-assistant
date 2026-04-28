/**
 * Integration tests for the `ui_request` IPC route.
 *
 * Exercises the full IPC round-trip: AssistantIpcServer + cliIpcCall over
 * the Unix domain socket, with mock findConversation / showStandaloneSurface
 * to verify submit / cancel / timeout, unknown-conversation, and
 * non-interactive failure scenarios.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { InteractiveUiResult } from "../../runtime/interactive-ui.js";

// ---------------------------------------------------------------------------
// Mock state — controls what requestInteractiveUi sees
// ---------------------------------------------------------------------------

/** When non-null, findConversation returns this object. */
let mockConversation: Record<string, unknown> | null = {
  conversationId: "conv-test-123",
  hasNoClient: false,
};

/** The result showStandaloneSurface will resolve with. */
let mockSurfaceResult: InteractiveUiResult = {
  status: "submitted",
  actionId: "confirm",
  surfaceId: "mock-surface-1",
};

/** When non-null, showStandaloneSurface throws this error. */
let mockSurfaceThrows: Error | null = null;

// Re-export the real module and override only findConversation.
const realStore = await import("../../daemon/conversation-store.js");
mock.module("../../daemon/conversation-store.js", () => ({
  ...realStore,
  findConversation: (_conversationId: string) => mockConversation ?? undefined,
}));

// Re-export the real module and override only showStandaloneSurface.
// The full module has many exports consumed transitively by the IPC server.
const realSurfaces = await import("../../daemon/conversation-surfaces.js");
mock.module("../../daemon/conversation-surfaces.js", () => ({
  ...realSurfaces,
  showStandaloneSurface: async (
    _ctx: unknown,
    _request: unknown,
    _surfaceId: string,
  ) => {
    if (mockSurfaceThrows) throw mockSurfaceThrows;
    return mockSurfaceResult;
  },
}));

// Import after mocking so the mock bindings are picked up
const { resetSurfaceIdCounterForTests } =
  await import("../../runtime/interactive-ui.js");
const { AssistantIpcServer } = await import("../assistant-server.js");
const { cliIpcCall } = await import("../cli-client.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let server: InstanceType<typeof AssistantIpcServer> | null = null;

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
  resetSurfaceIdCounterForTests();
  mockConversation = { conversationId: "conv-test-123", hasNoClient: false };
  mockSurfaceResult = {
    status: "submitted",
    actionId: "confirm",
    surfaceId: "mock-surface-1",
  };
  mockSurfaceThrows = null;
  server = new AssistantIpcServer();
  await server.start();
  // Allow the server socket to bind.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterEach(() => {
  server?.stop();
  server = null;
  resetSurfaceIdCounterForTests();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ui_request IPC route", () => {
  // ── Submit ────────────────────────────────────────────────────────

  test("returns submitted result when user selects an action", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "confirm",
      surfaceId: "mock-surface-1",
    };

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: {
        ...baseParams(),
        actions: [
          { id: "confirm", label: "Yes", variant: "primary" },
          { id: "deny", label: "No", variant: "secondary" },
        ],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("submitted");
    expect(result.result!.actionId).toBe("confirm");
    expect(result.result!.surfaceId).toBeDefined();
  });

  // ── Cancel ────────────────────────────────────────────────────────

  test("returns cancelled result when user dismisses the surface", async () => {
    mockSurfaceResult = {
      status: "cancelled",
      surfaceId: "mock-surface-2",
    };

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: baseParams(),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("cancelled");
  });

  // ── Timeout ───────────────────────────────────────────────────────

  test("returns timed_out result when the surface times out", async () => {
    mockSurfaceResult = {
      status: "timed_out",
      surfaceId: "mock-surface-3",
    };

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: baseParams({ timeoutMs: 1000 }),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("timed_out");
  });

  // ── showStandaloneSurface throws (resolver_error) ─────────────────

  test("returns cancelled with resolver_error reason when showStandaloneSurface throws", async () => {
    mockSurfaceThrows = new Error("Surface rendering failed");

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: baseParams({ conversationId: "conv-nonexistent" }),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("cancelled");
    expect(result.result!.cancellationReason).toBe("resolver_error");
    expect(result.result!.surfaceId).toBeDefined();
  });

  // ── Conversation not in memory (fail-closed) ─────────────────────

  test("returns cancelled with conversation_not_found when conversation is not in memory", async () => {
    mockConversation = null;

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: baseParams(),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("cancelled");
    expect(result.result!.cancellationReason).toBe("conversation_not_found");
    expect(result.result!.surfaceId).toBeDefined();
  });

  // ── Schema validation ─────────────────────────────────────────────

  test("rejects missing conversationId", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        surfaceType: "confirmation",
        data: { message: "test" },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects empty conversationId", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        conversationId: "",
        surfaceType: "confirmation",
        data: { message: "test" },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects invalid surfaceType", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        conversationId: "conv-1",
        surfaceType: "unsupported",
        data: {},
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects missing data field", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        conversationId: "conv-1",
        surfaceType: "confirmation",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects non-positive timeoutMs", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        conversationId: "conv-1",
        surfaceType: "confirmation",
        data: {},
        timeoutMs: 0,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects non-integer timeoutMs", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        conversationId: "conv-1",
        surfaceType: "confirmation",
        data: {},
        timeoutMs: 1.5,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects action with empty id", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        conversationId: "conv-1",
        surfaceType: "confirmation",
        data: {},
        actions: [{ id: "", label: "OK" }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects action with empty label", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        conversationId: "conv-1",
        surfaceType: "confirmation",
        data: {},
        actions: [{ id: "ok", label: "" }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  // ── Reserved action IDs ──────────────────────────────────────────

  test("rejects action with reserved id 'selection_changed'", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        ...baseParams(),
        actions: [{ id: "selection_changed", label: "Select" }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("reserved");
  });

  test("rejects action with reserved id 'content_changed'", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        ...baseParams(),
        actions: [{ id: "content_changed", label: "Change" }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("reserved");
  });

  test("rejects action with reserved id 'state_update'", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        ...baseParams(),
        actions: [{ id: "state_update", label: "Update" }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("reserved");
  });

  test("rejects action with reserved id 'cancel'", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        ...baseParams(),
        actions: [{ id: "cancel", label: "Cancel" }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("reserved");
  });

  test("rejects action with reserved id 'dismiss'", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        ...baseParams(),
        actions: [{ id: "dismiss", label: "Dismiss" }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("reserved");
  });

  test("rejects when any action in the array uses a reserved id", async () => {
    const result = await cliIpcCall("ui_request", {
      body: {
        ...baseParams(),
        actions: [
          { id: "approve", label: "Approve" },
          { id: "state_update", label: "Bad Action" },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("reserved");
  });

  // ── Optional fields ───────────────────────────────────────────────

  test("accepts request with optional title", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "ok",
      surfaceId: "mock-surface-title",
      summary: "Confirm Action",
    };

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: baseParams({ title: "Confirm Action" }),
    });

    expect(result.ok).toBe(true);
    expect(result.result!.status).toBe("submitted");
    expect(result.result!.summary).toBe("Confirm Action");
  });

  // ── Cancellation reason round-trip ────────────────────────────────

  test("round-trips user_dismissed cancellation reason", async () => {
    mockSurfaceResult = {
      status: "cancelled",
      surfaceId: "mock-surface-dismissed",
      cancellationReason: "user_dismissed",
    };

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: baseParams(),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("cancelled");
    expect(result.result!.cancellationReason).toBe("user_dismissed");
  });

  test("round-trips conversation_not_found cancellation reason", async () => {
    mockConversation = null;

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: baseParams({ conversationId: "conv-missing" }),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("cancelled");
    expect(result.result!.cancellationReason).toBe("conversation_not_found");
  });

  test("submitted result does not carry cancellationReason through IPC", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "confirm",
      surfaceId: "mock-surface-submitted",
    };

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: baseParams(),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("submitted");
    expect(result.result!.cancellationReason).toBeUndefined();
  });

  // ── Conversation found — surface succeeds ─────────────────────────

  test("succeeds when conversation is in memory", async () => {
    mockConversation = {
      conversationId: "conv-in-memory",
      hasNoClient: false,
    };
    mockSurfaceResult = {
      status: "submitted",
      actionId: "confirm",
      surfaceId: "hydrated-surface-conv-in-memory",
    };

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: baseParams({ conversationId: "conv-in-memory" }),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("submitted");
    expect(result.result!.actionId).toBe("confirm");
    expect(result.result!.surfaceId).toContain("conv-in-memory");
  });

  // ── Conversation not in memory ────────────────────────────────────

  test("returns cancelled with conversation_not_found for unknown conversation ID", async () => {
    mockConversation = null;

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: baseParams({ conversationId: "conv-truly-unknown-xyz" }),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.status).toBe("cancelled");
    expect(result.result!.cancellationReason).toBe("conversation_not_found");
    expect(result.result!.surfaceId).toBeDefined();
  });

  // ── Optional fields (continued) ────────────────────────────────────

  test("accepts form surfaceType with submittedData", async () => {
    mockSurfaceResult = {
      status: "submitted",
      submittedData: { name: "Alice", email: "alice@example.com" },
      surfaceId: "mock-surface-form",
    };

    const result = await cliIpcCall<InteractiveUiResult>("ui_request", {
      body: {
        conversationId: "conv-form",
        surfaceType: "form",
        data: { fields: [{ name: "name" }, { name: "email" }] },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.result!.status).toBe("submitted");
    expect(result.result!.submittedData).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
  });
});

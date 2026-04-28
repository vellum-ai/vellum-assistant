/**
 * Tests for the interactive UI request primitive.
 *
 * Mocks findConversation and showStandaloneSurface at the module boundary
 * so requestInteractiveUi can be exercised without the daemon conversation
 * store or real surface rendering.
 *
 * Exercise strategy:
 *   1. Missing conversation behavior (fail-closed).
 *   2. Delegation to showStandaloneSurface when conversation found.
 *   3. showStandaloneSurface error handling (fail-closed on throw).
 *   4. Surface ID generation and consistency.
 *   5. Decision token minting for submitted confirmation requests.
 *   6. Decision token absence for non-confirmation or non-submitted.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Import types statically (mock.module only affects runtime bindings)
import type {
  CancellationReason,
  InteractiveUiRequest,
} from "../interactive-ui.js";
import type { InteractiveUiResult } from "../interactive-ui.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** When set, findConversation returns this object. When null, returns undefined. */
let mockConversation: Record<string, unknown> | null = {
  conversationId: "conv-default",
  hasNoClient: false,
};

/** The result showStandaloneSurface will return. */
let mockSurfaceResult: InteractiveUiResult = {
  status: "submitted",
  actionId: "confirm",
  surfaceId: "mock-surface-1",
};

/** Whether showStandaloneSurface should throw. */
let mockSurfaceThrows: Error | null = null;

/** Captured calls to showStandaloneSurface. */
let surfaceCalls: Array<{
  ctx: unknown;
  request: unknown;
  surfaceId: string;
}> = [];

mock.module("../../daemon/conversation-store.js", () => ({
  findConversation: (_conversationId: string) => {
    return mockConversation ?? undefined;
  },
}));

mock.module("../../daemon/conversation-surfaces.js", () => ({
  showStandaloneSurface: async (
    ctx: unknown,
    request: unknown,
    surfaceId: string,
  ) => {
    surfaceCalls.push({ ctx, request, surfaceId });
    if (mockSurfaceThrows) throw mockSurfaceThrows;
    return mockSurfaceResult;
  },
}));

// Import runtime values after mocking
const { requestInteractiveUi, resetSurfaceIdCounterForTests } =
  await import("../interactive-ui.js");
const { decodeDecisionToken } = await import("../decision-token.js");

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  resetSurfaceIdCounterForTests();
  mockConversation = { conversationId: "conv-default", hasNoClient: false };
  mockSurfaceResult = {
    status: "submitted",
    actionId: "confirm",
    surfaceId: "mock-surface-1",
  };
  mockSurfaceThrows = null;
  surfaceCalls = [];
});

// ── Conversation not found (fail-closed) ─────────────────────────────

describe("requestInteractiveUi without conversation", () => {
  test("returns cancelled with conversation_not_found reason when conversation not in memory", async () => {
    mockConversation = null;

    const request: InteractiveUiRequest = {
      conversationId: "conv-1",
      surfaceType: "confirmation",
      data: { message: "Are you sure?" },
    };

    const result = await requestInteractiveUi(request);

    expect(result.status).toBe("cancelled");
    expect(result.cancellationReason).toBe("conversation_not_found");
    expect(result.surfaceId).toBeString();
    expect(result.surfaceId.length).toBeGreaterThan(0);
    expect(result.actionId).toBeUndefined();
    expect(result.submittedData).toBeUndefined();
    expect(surfaceCalls).toHaveLength(0);
  });

  test("generates a unique surfaceId per call", async () => {
    mockConversation = null;

    const request: InteractiveUiRequest = {
      conversationId: "conv-1",
      surfaceType: "confirmation",
      data: {},
    };

    const result1 = await requestInteractiveUi(request);
    const result2 = await requestInteractiveUi(request);

    expect(result1.surfaceId).not.toBe(result2.surfaceId);
  });

  test("does not mint decision token on fail-closed cancel", async () => {
    mockConversation = null;

    const result = await requestInteractiveUi({
      conversationId: "conv-failclosed",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.cancellationReason).toBe("conversation_not_found");
    expect(result.decisionToken).toBeUndefined();
  });
});

// ── Delegation to showStandaloneSurface ──────────────────────────────

describe("requestInteractiveUi with conversation", () => {
  test("delegates to showStandaloneSurface", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "confirm",
      surfaceId: "test-surface-1",
    };

    const request: InteractiveUiRequest = {
      conversationId: "conv-2",
      surfaceType: "confirmation",
      title: "Confirm deletion",
      data: { itemName: "important-file.txt" },
      actions: [
        { id: "confirm", label: "Delete", variant: "danger" },
        { id: "cancel", label: "Cancel", variant: "secondary" },
      ],
      timeoutMs: 30_000,
    };

    const result = await requestInteractiveUi(request);

    expect(result.status).toBe("submitted");
    expect(result.actionId).toBe("confirm");
    expect(result.surfaceId).toBe("test-surface-1");
    expect(surfaceCalls).toHaveLength(1);
    expect(surfaceCalls[0].surfaceId).toStartWith("ui-standalone-");
  });

  test("passes through timed_out status", async () => {
    mockSurfaceResult = {
      status: "timed_out",
      surfaceId: "timeout-surface",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-3",
      surfaceType: "confirmation",
      data: {},
      timeoutMs: 100,
    });

    expect(result.status).toBe("timed_out");
    expect(result.surfaceId).toBe("timeout-surface");
  });

  test("passes through cancelled status", async () => {
    mockSurfaceResult = {
      status: "cancelled",
      surfaceId: "cancelled-surface",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-4",
      surfaceType: "form",
      data: { fields: ["name", "email"] },
    });

    expect(result.status).toBe("cancelled");
    expect(result.surfaceId).toBe("cancelled-surface");
  });

  test("passes through submitted data", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "submit",
      submittedData: { name: "Alice", email: "alice@example.com" },
      summary: "Form submitted by user",
      surfaceId: "form-surface",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-5",
      surfaceType: "form",
      data: {},
    });

    expect(result.status).toBe("submitted");
    expect(result.actionId).toBe("submit");
    expect(result.submittedData).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(result.summary).toBe("Form submitted by user");
    expect(result.surfaceId).toBe("form-surface");
  });
});

// ── Error handling (fail-closed on throw) ────────────────────────────

describe("showStandaloneSurface error handling", () => {
  test("returns cancelled with resolver_error reason when showStandaloneSurface throws", async () => {
    mockSurfaceThrows = new Error("Surface rendering failed");

    const result = await requestInteractiveUi({
      conversationId: "conv-7",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.cancellationReason).toBe("resolver_error");
    expect(result.surfaceId).toBeString();
    expect(result.surfaceId.length).toBeGreaterThan(0);
  });

  test("does not mint decision token on error", async () => {
    mockSurfaceThrows = new Error("kaboom");

    const result = await requestInteractiveUi({
      conversationId: "conv-err-token",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.cancellationReason).toBe("resolver_error");
    expect(result.decisionToken).toBeUndefined();
  });
});

// ── Surface ID consistency ──────────────────────────────────────────

describe("surfaceId handling", () => {
  test("uses showStandaloneSurface-provided surfaceId when present", async () => {
    mockSurfaceResult = {
      status: "submitted",
      surfaceId: "resolver-provided-id",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-9",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.surfaceId).toBe("resolver-provided-id");
  });

  test("fills in surfaceId when showStandaloneSurface returns empty string", async () => {
    mockSurfaceResult = {
      status: "submitted",
      surfaceId: "",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-10",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.surfaceId).toStartWith("ui-interaction-");
  });
});

// ── Decision token minting ──────────────────────────────────────────

describe("decision token", () => {
  test("mints token for affirmative confirm action", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "confirm",
      surfaceId: "confirm-surface-1",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-token-1",
      surfaceType: "confirmation",
      data: { message: "Deploy to production?" },
    });

    expect(result.status).toBe("submitted");
    expect(result.decisionToken).toBeString();
    expect(result.decisionToken!.length).toBeGreaterThan(0);

    const payload = decodeDecisionToken(result.decisionToken!);
    expect(payload).not.toBeNull();
    expect(payload!.conversationId).toBe("conv-token-1");
    expect(payload!.surfaceId).toBe("confirm-surface-1");
    expect(payload!.action).toBe("confirm");
    expect(payload!.issuedAt).toBeString();
    expect(payload!.expiresAt).toBeString();
  });

  test("does not mint token for non-confirm actionId", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "approve",
      surfaceId: "approve-surface",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-token-approve",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("submitted");
    expect(result.actionId).toBe("approve");
    expect(result.decisionToken).toBeUndefined();
  });

  test("does not mint token for deny action", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "deny",
      surfaceId: "deny-surface",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-token-deny",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("submitted");
    expect(result.actionId).toBe("deny");
    expect(result.decisionToken).toBeUndefined();
  });

  test("does not mint token when actionId is absent", async () => {
    mockSurfaceResult = {
      status: "submitted",
      surfaceId: "no-action-surface",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-token-noaction",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("submitted");
    expect(result.decisionToken).toBeUndefined();
  });

  test("token has expiry in the future", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "confirm",
      surfaceId: "expiry-surface",
    };

    const before = Date.now();
    const result = await requestInteractiveUi({
      conversationId: "conv-token-expiry",
      surfaceType: "confirmation",
      data: {},
    });

    const payload = decodeDecisionToken(result.decisionToken!);
    const expiresAt = new Date(payload!.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt).toBeGreaterThan(before + 4 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(before + 6 * 60 * 1000);
  });

  test("does not mint token for submitted form request", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "submit",
      submittedData: { name: "Bob" },
      surfaceId: "form-no-token",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-form-notoken",
      surfaceType: "form",
      data: {},
    });

    expect(result.status).toBe("submitted");
    expect(result.decisionToken).toBeUndefined();
  });

  test("does not mint token for cancelled confirmation", async () => {
    mockSurfaceResult = {
      status: "cancelled",
      surfaceId: "cancel-no-token",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-cancel-notoken",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.decisionToken).toBeUndefined();
  });

  test("does not mint token for timed_out confirmation", async () => {
    mockSurfaceResult = {
      status: "timed_out",
      surfaceId: "timeout-no-token",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-timeout-notoken",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("timed_out");
    expect(result.decisionToken).toBeUndefined();
  });

  test("each minted token is unique", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "confirm",
      surfaceId: "unique-surface",
    };

    const result1 = await requestInteractiveUi({
      conversationId: "conv-unique-1",
      surfaceType: "confirmation",
      data: {},
    });

    const result2 = await requestInteractiveUi({
      conversationId: "conv-unique-1",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result1.decisionToken).not.toBe(result2.decisionToken);
  });
});

// ── Cancellation reason propagation ──────────────────────────────────

describe("cancellation reason", () => {
  test("conversation_not_found reason when conversation not in memory", async () => {
    mockConversation = null;

    const result = await requestInteractiveUi({
      conversationId: "conv-reason-not-found",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.cancellationReason).toBe(
      "conversation_not_found" satisfies CancellationReason,
    );
  });

  test("resolver_error reason when showStandaloneSurface throws", async () => {
    mockSurfaceThrows = new Error("boom");

    const result = await requestInteractiveUi({
      conversationId: "conv-reason-error",
      surfaceType: "form",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.cancellationReason).toBe(
      "resolver_error" satisfies CancellationReason,
    );
  });

  test("passes through user_dismissed reason from showStandaloneSurface", async () => {
    mockSurfaceResult = {
      status: "cancelled",
      surfaceId: "dismissed-surface",
      cancellationReason: "user_dismissed",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-reason-user-dismissed",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.cancellationReason).toBe("user_dismissed");
  });

  test("submitted result does not carry cancellationReason", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "confirm",
      surfaceId: "no-reason-submit",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-reason-submitted",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("submitted");
    expect(result.cancellationReason).toBeUndefined();
  });

  test("timed_out result does not carry cancellationReason", async () => {
    mockSurfaceResult = {
      status: "timed_out",
      surfaceId: "no-reason-timeout",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-reason-timeout",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("timed_out");
    expect(result.cancellationReason).toBeUndefined();
  });
});

// ── Contract shape validation ───────────────────────────────────────

describe("contract shapes", () => {
  test("result contract — submitted with all optional fields", async () => {
    mockSurfaceResult = {
      status: "submitted",
      actionId: "confirm",
      submittedData: { choice: "yes" },
      summary: "User confirmed the action",
      surfaceId: "full-result-surface",
    };

    const result = await requestInteractiveUi({
      conversationId: "conv-contract",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("submitted");
    expect(result.actionId).toBe("confirm");
    expect(result.submittedData).toEqual({ choice: "yes" });
    expect(result.summary).toBe("User confirmed the action");
    expect(result.surfaceId).toBe("full-result-surface");
    expect(result.decisionToken).toBeString();
  });
});

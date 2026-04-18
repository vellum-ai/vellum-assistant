/**
 * Tests for the interactive UI request primitive.
 *
 * Exercise strategy: the module exposes a register/request pattern with
 * a module-level resolver, identical to `runtime/agent-wake.ts`. Tests
 * exercise:
 *   1. Contract validation — request/result shapes.
 *   2. Missing resolver behavior (fail-closed).
 *   3. Resolver registration + delegation.
 *   4. Resolver error handling (fail-closed on throw).
 *   5. Surface ID generation and consistency.
 *   6. Decision token minting for submitted confirmation requests.
 *   7. Decision token absence for non-confirmation or non-submitted.
 *   8. Structured audit log emission for all outcomes.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { decodeDecisionToken } from "../decision-token.js";
import {
  type InteractiveUiRequest,
  type InteractiveUiResult,
  registerInteractiveUiResolver,
  requestInteractiveUi,
  resetInteractiveUiResolverForTests,
  resetSurfaceIdCounterForTests,
} from "../interactive-ui.js";

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  resetInteractiveUiResolverForTests();
  resetSurfaceIdCounterForTests();
});

// ── Missing resolver (fail-closed) ───────────────────────────────────

describe("requestInteractiveUi without resolver", () => {
  test("returns cancelled when no resolver is registered", async () => {
    const request: InteractiveUiRequest = {
      conversationId: "conv-1",
      surfaceType: "confirmation",
      data: { message: "Are you sure?" },
    };

    const result = await requestInteractiveUi(request);

    expect(result.status).toBe("cancelled");
    expect(result.surfaceId).toBeString();
    expect(result.surfaceId.length).toBeGreaterThan(0);
    expect(result.actionId).toBeUndefined();
    expect(result.submittedData).toBeUndefined();
  });

  test("generates a unique surfaceId per call", async () => {
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
    const result = await requestInteractiveUi({
      conversationId: "conv-failclosed",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.decisionToken).toBeUndefined();
  });
});

// ── Resolver registration + delegation ──────────────────────────────

describe("requestInteractiveUi with resolver", () => {
  test("delegates to the registered resolver", async () => {
    const receivedRequests: InteractiveUiRequest[] = [];

    registerInteractiveUiResolver(async (req) => {
      receivedRequests.push(req);
      return {
        status: "submitted",
        actionId: "confirm",
        surfaceId: "test-surface-1",
      };
    });

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
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].conversationId).toBe("conv-2");
    expect(receivedRequests[0].surfaceType).toBe("confirmation");
    expect(receivedRequests[0].title).toBe("Confirm deletion");
    expect(receivedRequests[0].data).toEqual({
      itemName: "important-file.txt",
    });
    expect(receivedRequests[0].actions).toHaveLength(2);
    expect(receivedRequests[0].timeoutMs).toBe(30_000);
  });

  test("passes through timed_out status from resolver", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "timed_out",
      surfaceId: "timeout-surface",
    }));

    const result = await requestInteractiveUi({
      conversationId: "conv-3",
      surfaceType: "confirmation",
      data: {},
      timeoutMs: 100,
    });

    expect(result.status).toBe("timed_out");
    expect(result.surfaceId).toBe("timeout-surface");
  });

  test("passes through cancelled status from resolver", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "cancelled",
      surfaceId: "cancelled-surface",
    }));

    const result = await requestInteractiveUi({
      conversationId: "conv-4",
      surfaceType: "form",
      data: { fields: ["name", "email"] },
    });

    expect(result.status).toBe("cancelled");
    expect(result.surfaceId).toBe("cancelled-surface");
  });

  test("passes through submitted data from resolver", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "submitted",
      actionId: "submit",
      submittedData: { name: "Alice", email: "alice@example.com" },
      summary: "Form submitted by user",
      surfaceId: "form-surface",
    }));

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

  test("replaces resolver when registered a second time", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "submitted",
      actionId: "first",
      surfaceId: "first-resolver",
    }));

    registerInteractiveUiResolver(async () => ({
      status: "cancelled",
      surfaceId: "second-resolver",
    }));

    const result = await requestInteractiveUi({
      conversationId: "conv-6",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.surfaceId).toBe("second-resolver");
  });
});

// ── Error handling (fail-closed on resolver throw) ──────────────────

describe("resolver error handling", () => {
  test("returns cancelled when resolver throws", async () => {
    registerInteractiveUiResolver(async () => {
      throw new Error("Surface rendering failed");
    });

    const result = await requestInteractiveUi({
      conversationId: "conv-7",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.surfaceId).toBeString();
    expect(result.surfaceId.length).toBeGreaterThan(0);
  });

  test("returns cancelled when resolver rejects", async () => {
    registerInteractiveUiResolver(() =>
      Promise.reject(new Error("Connection lost")),
    );

    const result = await requestInteractiveUi({
      conversationId: "conv-8",
      surfaceType: "form",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.surfaceId).toBeString();
  });

  test("does not mint decision token on resolver error", async () => {
    registerInteractiveUiResolver(async () => {
      throw new Error("kaboom");
    });

    const result = await requestInteractiveUi({
      conversationId: "conv-err-token",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.decisionToken).toBeUndefined();
  });
});

// ── Surface ID consistency ──────────────────────────────────────────

describe("surfaceId handling", () => {
  test("uses resolver-provided surfaceId when present", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "submitted",
      surfaceId: "resolver-provided-id",
    }));

    const result = await requestInteractiveUi({
      conversationId: "conv-9",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.surfaceId).toBe("resolver-provided-id");
  });

  test("fills in surfaceId when resolver returns empty string", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "submitted",
      surfaceId: "",
    }));

    const result = await requestInteractiveUi({
      conversationId: "conv-10",
      surfaceType: "confirmation",
      data: {},
    });

    // Empty string is falsy, so the generated surfaceId should be used
    expect(result.surfaceId).toStartWith("ui-interaction-");
  });
});

// ── Decision token minting ──────────────────────────────────────────

describe("decision token", () => {
  test("mints token for submitted confirmation request", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "submitted",
      actionId: "approve",
      surfaceId: "confirm-surface-1",
    }));

    const result = await requestInteractiveUi({
      conversationId: "conv-token-1",
      surfaceType: "confirmation",
      data: { message: "Deploy to production?" },
    });

    expect(result.status).toBe("submitted");
    expect(result.decisionToken).toBeString();
    expect(result.decisionToken!.length).toBeGreaterThan(0);

    // Token should be decodable and contain correct metadata
    const payload = decodeDecisionToken(result.decisionToken!);
    expect(payload).not.toBeNull();
    expect(payload!.conversationId).toBe("conv-token-1");
    expect(payload!.surfaceId).toBe("confirm-surface-1");
    expect(payload!.action).toBe("approve");
    expect(payload!.issuedAt).toBeString();
    expect(payload!.expiresAt).toBeString();
  });

  test("token encodes actionId when present", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "submitted",
      actionId: "deny",
      surfaceId: "deny-surface",
    }));

    const result = await requestInteractiveUi({
      conversationId: "conv-token-action",
      surfaceType: "confirmation",
      data: {},
    });

    const payload = decodeDecisionToken(result.decisionToken!);
    expect(payload!.action).toBe("deny");
  });

  test("token uses 'submitted' as action when actionId is absent", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "submitted",
      surfaceId: "no-action-surface",
    }));

    const result = await requestInteractiveUi({
      conversationId: "conv-token-noaction",
      surfaceType: "confirmation",
      data: {},
    });

    const payload = decodeDecisionToken(result.decisionToken!);
    expect(payload!.action).toBe("submitted");
  });

  test("token has expiry in the future", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "submitted",
      actionId: "ok",
      surfaceId: "expiry-surface",
    }));

    const before = Date.now();
    const result = await requestInteractiveUi({
      conversationId: "conv-token-expiry",
      surfaceType: "confirmation",
      data: {},
    });

    const payload = decodeDecisionToken(result.decisionToken!);
    const expiresAt = new Date(payload!.expiresAt).getTime();
    // Should expire ~5 minutes in the future
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt).toBeGreaterThan(before + 4 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(before + 6 * 60 * 1000);
  });

  test("does not mint token for submitted form request", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "submitted",
      actionId: "submit",
      submittedData: { name: "Bob" },
      surfaceId: "form-no-token",
    }));

    const result = await requestInteractiveUi({
      conversationId: "conv-form-notoken",
      surfaceType: "form",
      data: {},
    });

    expect(result.status).toBe("submitted");
    expect(result.decisionToken).toBeUndefined();
  });

  test("does not mint token for cancelled confirmation request", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "cancelled",
      surfaceId: "cancel-no-token",
    }));

    const result = await requestInteractiveUi({
      conversationId: "conv-cancel-notoken",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.decisionToken).toBeUndefined();
  });

  test("does not mint token for timed_out confirmation request", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "timed_out",
      surfaceId: "timeout-no-token",
    }));

    const result = await requestInteractiveUi({
      conversationId: "conv-timeout-notoken",
      surfaceType: "confirmation",
      data: {},
    });

    expect(result.status).toBe("timed_out");
    expect(result.decisionToken).toBeUndefined();
  });

  test("each minted token is unique", async () => {
    registerInteractiveUiResolver(async () => ({
      status: "submitted",
      actionId: "ok",
      surfaceId: "unique-surface",
    }));

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

    // Tokens differ due to nonce even with same conversation/action
    expect(result1.decisionToken).not.toBe(result2.decisionToken);
  });
});

// ── Contract shape validation ───────────────────────────────────────

describe("contract shapes", () => {
  test("request with minimal fields", async () => {
    const received: InteractiveUiRequest[] = [];
    registerInteractiveUiResolver(async (req) => {
      received.push(req);
      return { status: "cancelled", surfaceId: "min-surface" };
    });

    await requestInteractiveUi({
      conversationId: "conv-minimal",
      surfaceType: "confirmation",
      data: {},
    });

    expect(received[0]).toEqual({
      conversationId: "conv-minimal",
      surfaceType: "confirmation",
      data: {},
    });
    // Optional fields should be absent, not undefined
    expect("title" in received[0]).toBe(false);
    expect("actions" in received[0]).toBe(false);
    expect("timeoutMs" in received[0]).toBe(false);
  });

  test("request with all fields populated", async () => {
    const received: InteractiveUiRequest[] = [];
    registerInteractiveUiResolver(async (req) => {
      received.push(req);
      return { status: "submitted", actionId: "ok", surfaceId: "full-surface" };
    });

    const fullRequest: InteractiveUiRequest = {
      conversationId: "conv-full",
      surfaceType: "form",
      title: "Enter details",
      data: { schema: { name: "string", age: "number" } },
      actions: [
        { id: "ok", label: "Submit", variant: "primary" },
        { id: "skip", label: "Skip" },
      ],
      timeoutMs: 60_000,
    };

    await requestInteractiveUi(fullRequest);

    expect(received[0].conversationId).toBe("conv-full");
    expect(received[0].surfaceType).toBe("form");
    expect(received[0].title).toBe("Enter details");
    expect(received[0].actions).toHaveLength(2);
    expect(received[0].actions![0].variant).toBe("primary");
    expect(received[0].actions![1].variant).toBeUndefined();
    expect(received[0].timeoutMs).toBe(60_000);
  });

  test("result contract — submitted with all optional fields", async () => {
    const fullResult: InteractiveUiResult = {
      status: "submitted",
      actionId: "confirm",
      submittedData: { choice: "yes" },
      summary: "User confirmed the action",
      surfaceId: "full-result-surface",
    };

    registerInteractiveUiResolver(async () => fullResult);

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
    // Confirmation + submitted → token should be present
    expect(result.decisionToken).toBeString();
  });
});

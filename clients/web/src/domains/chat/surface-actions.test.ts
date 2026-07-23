/**
 * Funnel telemetry for first-run scope option clicks.
 *
 * The "Let's chat" kickoff greeting renders a choice surface whose options
 * carry `data: { firstRunScope: ... }` (see `first-run-scope.ts`). Clicking
 * one must emit exactly one funnel event with the chosen scope — and only
 * then: other surface actions emit nothing, failed submits emit nothing, and
 * a throwing emitter must never break the surface-action path (telemetry is
 * strictly fire-and-forget).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { SurfaceActionResult } from "@/domains/chat/api/surfaces";

let submitResult: SurfaceActionResult = { ok: true };
let submitThrows = false;
const submitCalls: Array<Record<string, unknown> | undefined> = [];

mock.module("@/domains/chat/api/surfaces", () => ({
  submitSurfaceAction: async (
    _assistantId: string,
    _surfaceId: string,
    _actionId: string,
    data?: Record<string, unknown>,
  ): Promise<SurfaceActionResult> => {
    submitCalls.push(data);
    if (submitThrows) throw new Error("network down");
    return submitResult;
  },
}));

const emittedScopes: string[] = [];
let emitThrows = false;

mock.module("@/domains/onboarding/funnel-events", () => ({
  emitFirstMessageScopeSelected: (scope: string): void => {
    emittedScopes.push(scope);
    if (emitThrows) throw new Error("telemetry down");
  },
}));

const { handleSurfaceAction } = await import("@/domains/chat/surface-actions");
const { FIRST_RUN_SCOPE_DATA_KEY } = await import(
  "@/domains/onboarding/first-run-scope"
);
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);
const { useStreamStore } = await import("@/domains/chat/stream-store");
const { useTurnStore } = await import("@/domains/chat/turn-store");

beforeEach(() => {
  submitResult = { ok: true };
  submitThrows = false;
  submitCalls.length = 0;
  emittedScopes.length = 0;
  emitThrows = false;
  useStreamStore.getState().setStreamContext({
    assistantId: "ast-1",
    conversationId: "conv-1",
  });
  useChatSessionStore.getState().setError(null);
  useTurnStore.getState().resetTurn();
});

describe("handleSurfaceAction — first-run scope funnel event", () => {
  it("emits exactly one event with the chosen scope", async () => {
    await handleSurfaceAction("srf-1", "scope_work", {
      [FIRST_RUN_SCOPE_DATA_KEY]: "work",
    });

    expect(emittedScopes).toEqual(["work"]);
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  it("emits nothing for surface actions without the scope marker", async () => {
    await handleSurfaceAction("srf-1", "confirm", { choice: "blue" });
    await handleSurfaceAction("srf-1", "confirm");

    expect(submitCalls).toHaveLength(2);
    expect(emittedScopes).toEqual([]);
  });

  it("emits nothing when the marker value is not a known scope", async () => {
    await handleSurfaceAction("srf-1", "scope_other", {
      [FIRST_RUN_SCOPE_DATA_KEY]: "everything",
    });

    expect(emittedScopes).toEqual([]);
  });

  it("emits nothing when the submit fails", async () => {
    submitResult = { ok: false };

    await handleSurfaceAction("srf-1", "scope_personal", {
      [FIRST_RUN_SCOPE_DATA_KEY]: "personal",
    });

    expect(emittedScopes).toEqual([]);
    expect(useChatSessionStore.getState().error?.message).toBe(
      "Failed to submit. Please try again.",
    );
  });

  it("emits nothing when the submit throws", async () => {
    submitThrows = true;

    await handleSurfaceAction("srf-1", "scope_personal", {
      [FIRST_RUN_SCOPE_DATA_KEY]: "personal",
    });

    expect(emittedScopes).toEqual([]);
  });

  it("emits nothing for guardian decision actions", async () => {
    submitResult = { ok: true, applied: false, reason: "expired" };

    await handleSurfaceAction("srf-1", "apr:allow", {
      [FIRST_RUN_SCOPE_DATA_KEY]: "both",
    });

    expect(emittedScopes).toEqual([]);
  });

  it("a throwing emitter does not break the action path", async () => {
    emitThrows = true;

    await handleSurfaceAction("srf-1", "scope_both", {
      [FIRST_RUN_SCOPE_DATA_KEY]: "both",
    });

    // The emitter was invoked (and threw)…
    expect(emittedScopes).toEqual(["both"]);
    // …but the action path completed: no error banner, and the turn store
    // was signaled to expect a reply.
    expect(useChatSessionStore.getState().error).toBeNull();
    expect(useTurnStore.getState().phase).toBe("thinking");
  });
});

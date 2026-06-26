/**
 * Tests for `useAcpRunRehydration`'s reconnect path — re-seeding ACP runs when
 * the SSE stream reopens. ACP events missed during an outage aren't
 * ring-replayed (they carry no `conversationId`), so a reopen past the replay
 * ring must re-fetch `/acp/sessions`. Mirrors the conversation-history reconnect
 * refetch test. (Data-shaping is covered by use-acp-run-rehydration.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { __resetForTesting, publish } from "@/lib/event-bus";

// Count daemon GETs; `fetchAcpSessions` calls `daemonClient.get` synchronously
// when the reconnect handler runs, so the counter settles before assertions.
// `mockOk`/`mockSessions` let a test stage an authoritative snapshot (or a
// failed fetch) to exercise the reconcile/retire path.
let getCalls = 0;
let mockOk = true;
let mockSessions: unknown[] = [];
let lastQuery: Record<string, unknown> | undefined;
mock.module("@/generated/daemon/client.gen", () => ({
  client: {
    get: async (opts?: { query?: Record<string, unknown> }) => {
      getCalls += 1;
      lastQuery = opts?.query;
      return {
        data: mockOk ? { sessions: mockSessions } : undefined,
        response: { ok: mockOk },
      };
    },
  },
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));

const { useAcpRunRehydration } = await import(
  "@/domains/chat/hooks/use-acp-run-rehydration"
);
const { useAcpRunStore } = await import("@/domains/chat/acp-run-store");

function mount(
  assistantId: string | null = "asst-1",
  conversationId: string | null = "conv-A",
) {
  const result = renderHook(() =>
    useAcpRunRehydration(assistantId, conversationId),
  );
  // Ignore the conversation-change mount fetch; isolate the reconnect path.
  getCalls = 0;
  return result;
}

beforeEach(() => {
  __resetForTesting();
  getCalls = 0;
  mockOk = true;
  mockSessions = [];
  lastQuery = undefined;
  useAcpRunStore.getState().reset();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  useAcpRunStore.getState().reset();
});

describe("useAcpRunRehydration — refetch on SSE reopen", () => {
  test("re-fetches on a resume reopen", () => {
    mount("asst-1", "conv-A");
    publish("sse.opened", { assistantId: "asst-1", cause: "resume" });
    expect(getCalls).toBe(1);
  });

  test("requests the snapshot with an explicit limit", () => {
    mount("asst-1", "conv-A");
    publish("sse.opened", { assistantId: "asst-1", cause: "resume" });
    expect(lastQuery).toMatchObject({ conversationId: "conv-A", limit: 50 });
  });

  test.each([["error"], ["watchdog"], ["debug"]] as const)(
    "re-fetches on a '%s' reconnect",
    (cause) => {
      mount("asst-1", "conv-A");
      publish("sse.opened", { assistantId: "asst-1", cause });
      expect(getCalls).toBe(1);
    },
  );

  test("does not re-fetch on the first 'fresh' open", () => {
    mount("asst-1", "conv-A");
    publish("sse.opened", { assistantId: "asst-1", cause: "fresh" });
    expect(getCalls).toBe(0);
  });

  test("does not re-fetch on a cold-start 'anchor' reopen", () => {
    mount("asst-1", "conv-A");
    publish("sse.opened", { assistantId: "asst-1", cause: "anchor" });
    expect(getCalls).toBe(0);
  });

  test("ignores reopens for a different assistant", () => {
    mount("asst-1", "conv-A");
    publish("sse.opened", { assistantId: "asst-other", cause: "resume" });
    expect(getCalls).toBe(0);
  });

  test("does not re-fetch when there is no active conversation", () => {
    mount("asst-1", null);
    publish("sse.opened", { assistantId: "asst-1", cause: "resume" });
    expect(getCalls).toBe(0);
  });
});

describe("useAcpRunRehydration — reconcile stale runs against the snapshot", () => {
  const flush = () => new Promise((r) => setTimeout(r, 5));

  function seedActiveRun(acpSessionId: string, parentConversationId: string) {
    useAcpRunStore.getState().spawnRun({
      acpSessionId,
      agent: "claude",
      parentConversationId,
      startedAt: 0,
    });
  }

  test("retires an active run absent from an authoritative empty snapshot", async () => {
    seedActiveRun("run-A", "conv-A");
    mockSessions = []; // authoritative: daemon no longer reports run-A
    renderHook(() => useAcpRunRehydration("asst-1", "conv-A"));

    await waitFor(() => {
      expect(useAcpRunStore.getState().byId["run-A"]!.status).toBe("cancelled");
    });
    expect(useAcpRunStore.getState().byId["run-A"]!.stopReason).toBe(
      "daemon_restarted",
    );
  });

  test("does not retire from a full (possibly truncated) snapshot page", async () => {
    seedActiveRun("run-A", "conv-A");
    // A full page (== the limit) may have paginated run-A off rather than
    // genuinely dropped it, so absence isn't authoritative — don't retire.
    mockSessions = Array.from({ length: 50 }, (_, i) => ({
      id: `s-${i}`,
      acpSessionId: `s-${i}`,
      status: "completed",
      parentConversationId: "conv-A",
      startedAt: i,
    }));
    renderHook(() => useAcpRunRehydration("asst-1", "conv-A"));

    await flush();
    expect(useAcpRunStore.getState().byId["run-A"]!.status).toBe("running");
  });

  test("does not retire on a failed fetch (null snapshot)", async () => {
    seedActiveRun("run-A", "conv-A");
    mockOk = false; // fetch failed — not authoritative
    renderHook(() => useAcpRunRehydration("asst-1", "conv-A"));

    await flush();
    expect(useAcpRunStore.getState().byId["run-A"]!.status).toBe("running");
  });

  test("does not retire a run that belongs to a different conversation", async () => {
    seedActiveRun("run-B", "conv-B");
    mockSessions = [];
    renderHook(() => useAcpRunRehydration("asst-1", "conv-A"));

    await flush();
    expect(useAcpRunStore.getState().byId["run-B"]!.status).toBe("running");
  });
});

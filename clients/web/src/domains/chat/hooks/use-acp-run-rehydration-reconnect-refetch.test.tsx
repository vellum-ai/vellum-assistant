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
// Set by a test that needs to control response ordering; otherwise the default
// below answers immediately from `mockSessions`.
let mockGetImpl: undefined | (() => Promise<unknown>);
mock.module("@/generated/daemon/client.gen", () => ({
  client: {
    get: async (opts?: { query?: Record<string, unknown> }) => {
      getCalls += 1;
      lastQuery = opts?.query;
      if (mockGetImpl) {
        return mockGetImpl();
      }
      return {
        data: mockOk ? { sessions: mockSessions } : undefined,
        response: { ok: mockOk },
      };
    },
  },
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));

const { useAcpRunRehydration, __resetAcpSnapshotGenerationsForTests } =
  await import("@/domains/chat/hooks/use-acp-run-rehydration");
const { useAcpRunStore } = await import("@/domains/chat/acp-run-store");
const { useInteractionStore } =
  await import("@/domains/chat/interaction-store");
const { SYNC_TAGS } = await import("@/lib/sync/types");

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

describe("useAcpRunRehydration: the auth-recovery tag is a refetch trigger", () => {
  const flush = () => new Promise((r) => setTimeout(r, 5));

  function publishRecoveryTag() {
    publish("sse.event", {
      assistantId: "asst-1",
      message: {
        type: "sync_changed",
        tags: [SYNC_TAGS.acpAuthRecovery],
      },
    } as never);
  }

  function seedRestoredPrompt() {
    useInteractionStore.setState({
      pendingAcpConnect: {
        toolUseId: "tool-anchor",
        reason: "auth_required",
        conversationId: "conv-A",
      },
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
    });
  }

  const markedRun = {
    id: "run-marked",
    agentId: "claude",
    acpSessionId: "run-marked",
    parentConversationId: "conv-A",
    status: "failed",
    startedAt: 1,
    parentToolUseId: "tool-anchor",
    authErrorCode: "acp_claude_auth_required",
  };

  test("keeps the prompt when the snapshot still carries the marker", async () => {
    // The tag says a Claude token was written, not that the failure is
    // repaired: the write may have stored a value a spawn cannot use, and the
    // daemon goes on serving the marker for that reason. Dismissing on the tag
    // records the tool-use id, and the marked snapshot could then no longer
    // restore the card.
    seedRestoredPrompt();
    mockSessions = [markedRun];
    renderHook(() => useAcpRunRehydration("asst-1", "conv-A"));

    publishRecoveryTag();
    await flush();

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-anchor",
    );
    expect(
      useInteractionStore.getState().dismissedAcpConnectToolUseIds.size,
    ).toBe(0);
  });

  test("retires the prompt once the snapshot comes back unmarked", async () => {
    // The authoritative answer, and the only thing that retires the card.
    seedRestoredPrompt();
    mockSessions = [{ ...markedRun, authErrorCode: undefined }];
    renderHook(() => useAcpRunRehydration("asst-1", "conv-A"));

    publishRecoveryTag();
    await flush();

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("still refetches on the tag", async () => {
    seedRestoredPrompt();
    mockSessions = [markedRun];
    mount("asst-1", "conv-A");

    publishRecoveryTag();
    await flush();

    expect(getCalls).toBeGreaterThan(0);
  });
});

describe("useAcpRunRehydration: a config change is also a reason to re-read", () => {
  const flush = () => new Promise((r) => setTimeout(r, 5));

  test("refetches on the assistant-config tag", async () => {
    // A configured `CLAUDE_CODE_OAUTH_TOKEN` wins over the vault, so editing
    // it repairs auth with no credential write anywhere. Only the config tag
    // is published, and without listening for it the card stands until
    // navigation even though the next spawn will succeed.
    mockSessions = [];
    mount("asst-1", "conv-A");

    publish("sse.event", {
      assistantId: "asst-1",
      message: {
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantConfig],
      },
    } as never);
    await flush();

    expect(getCalls).toBeGreaterThan(0);
  });

  test("ignores tags it has no stake in", async () => {
    mockSessions = [];
    mount("asst-1", "conv-A");

    publish("sse.event", {
      assistantId: "asst-1",
      message: { type: "sync_changed", tags: ["something:else"] },
    } as never);
    await flush();

    expect(getCalls).toBe(0);
  });
});

describe("useAcpRunRehydration: an older snapshot cannot overwrite a newer one", () => {
  const flush = () => new Promise((r) => setTimeout(r, 5));

  test("a marked response that a newer unmarked one overtook raises nothing", async () => {
    // The revision cannot order these on its own: it moves when the prompt
    // changes, so a newer authoritative snapshot that finds nothing to change
    // leaves it untouched, and the older marked response then still looks
    // current.
    __resetAcpSnapshotGenerationsForTests();
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
      acpConnectFlowActive: false,
    });

    // Hold the first fetch open so the second can overtake it.
    let releaseFirst = (_v: unknown) => {};
    const firstBody = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    mockGetImpl = async () => {
      call += 1;
      if (call === 1) {
        await firstBody;
        return {
          data: {
            sessions: [
              {
                id: "run-marked",
                agentId: "claude",
                acpSessionId: "run-marked",
                parentConversationId: "conv-A",
                status: "failed",
                startedAt: 1,
                parentToolUseId: "tool-stale",
                authErrorCode: "acp_claude_auth_required",
              },
            ],
          },
          response: { ok: true },
        };
      }
      return { data: { sessions: [] }, response: { ok: true } };
    };

    renderHook(() => useAcpRunRehydration("asst-1", "conv-A"));
    await flush();
    // The invalidation starts a second, newer fetch that completes first.
    publish("sse.event", {
      assistantId: "asst-1",
      message: { type: "sync_changed", tags: [SYNC_TAGS.acpAuthRecovery] },
    } as never);
    await flush();
    releaseFirst(undefined);
    await flush();

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
    mockGetImpl = undefined;
  });
});

describe("useAcpRunRehydration: re-reading once a Connect flow settles", () => {
  const flush = () => new Promise((r) => setTimeout(r, 5));

  test("refetches when the flow goes inactive", async () => {
    // A flow holds the prompt on its own anchor, so any auth failure arriving
    // while it ran was turned away rather than queued, and its own token write
    // invalidated while the flow was still active so that refetch was turned
    // away too. Without this the newer failure waits for a navigation.
    useInteractionStore.setState({ acpConnectFlowActive: true });
    mockSessions = [];
    mount("asst-1", "conv-A");

    useInteractionStore.getState().setAcpConnectFlowActive(false);
    await flush();

    expect(getCalls).toBeGreaterThan(0);
  });

  test("mounting with no flow running does not add a fetch", async () => {
    // The conversation effect already loads on mount; only the falling edge
    // is a new reason to look.
    useInteractionStore.setState({ acpConnectFlowActive: false });
    mockSessions = [];
    mount("asst-1", "conv-A");
    await flush();

    expect(getCalls).toBe(0);
  });

  test("entering a flow does not refetch", async () => {
    useInteractionStore.setState({ acpConnectFlowActive: false });
    mockSessions = [];
    mount("asst-1", "conv-A");

    useInteractionStore.getState().setAcpConnectFlowActive(true);
    await flush();

    expect(getCalls).toBe(0);
  });
});

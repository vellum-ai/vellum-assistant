/**
 * Tests for `useAcpRunRehydration`'s reconnect path — re-seeding ACP runs when
 * the SSE stream reopens. ACP events missed during an outage aren't
 * ring-replayed (they carry no `conversationId`), so a reopen past the replay
 * ring must re-fetch `/acp/sessions`. Mirrors the conversation-history reconnect
 * refetch test. (Data-shaping is covered by use-acp-run-rehydration.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { __resetForTesting, publish } from "@/lib/event-bus";

// Count daemon GETs; `fetchAcpSessions` calls `daemonClient.get` synchronously
// when the reconnect handler runs, so the counter settles before assertions.
let getCalls = 0;
mock.module("@/generated/daemon/client.gen", () => ({
  client: {
    get: async () => {
      getCalls += 1;
      return { data: { sessions: [] }, response: { ok: true } };
    },
  },
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));

const { useAcpRunRehydration } = await import(
  "@/domains/chat/hooks/use-acp-run-rehydration"
);

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
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useAcpRunRehydration — refetch on SSE reopen", () => {
  test("re-fetches on a resume reopen", () => {
    mount("asst-1", "conv-A");
    publish("sse.opened", { assistantId: "asst-1", cause: "resume" });
    expect(getCalls).toBe(1);
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

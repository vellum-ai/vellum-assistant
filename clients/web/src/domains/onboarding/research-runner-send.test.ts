/**
 * Tests for how the research runner opens its side conversation: the prompt is
 * posted hidden (see `lib/side-conversation-message.ts`), and a resumed run
 * re-posts only when the turn never started.
 *
 * Hidden rows are filtered out of `/messages`, so "did the prompt land?" reads
 * the turn's own state (still processing, or rows already produced) instead of
 * looking for a user row.
 *
 * NOTE: `bun mock.module` can leak across files. Run this file singly:
 *   bun test src/domains/onboarding/research-runner-send.test.ts
 */

import { createElement, type ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ResearchSubject } from "@/domains/onboarding/research-prompt";
import * as sdkGen from "@/generated/daemon/sdk.gen";

interface PostCall {
  path: { assistant_id: string };
  body: { conversationId: string; hidden?: boolean };
}

let postCalls: PostCall[] = [];
let getCalls = 0;
let listed: { processing?: boolean; messages: unknown[] } = { messages: [] };

const ok = <T>(data: T) =>
  Promise.resolve({ data, error: undefined, response: { ok: true } });

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  pluginsSearchGet: () => ok({ matches: [] }),
  pluginsInstallPost: () => ok({}),
  telemetryIngestPost: () => ok({}),
  conversationsPost: () => ok({ id: "conv-fresh" }),
  conversationsByIdArchivePost: () => ok({}),
  messagesGet: () => {
    getCalls += 1;
    return ok(listed);
  },
  messagesPost: (opts: PostCall) => {
    postCalls.push(opts);
    return ok({});
  },
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));

const { useResearchRunner } =
  await import("@/domains/onboarding/research-runner");

const subject: ResearchSubject = {
  firstName: "Alice",
  lastName: "Example",
  occupation: "Engineer",
  hobbies: [],
  timezone: "UTC",
};

function renderRunner() {
  const queryClient = new QueryClient();
  return renderHook(() => useResearchRunner(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  });
}

afterEach(() => {
  postCalls = [];
  getCalls = 0;
  listed = { messages: [] };
});

/**
 * The resume branch reads `/messages` once and decides synchronously on the
 * result, so observing that read is enough to assert on the decision. The poll
 * loop's own reads are a poll interval away.
 */
async function whenResumeDecided(): Promise<void> {
  await waitFor(() => {
    expect(getCalls).toBeGreaterThan(0);
  });
}

describe("research prompt send", () => {
  test("posts the prompt as a hidden machine signal", async () => {
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
      });
    });

    await waitFor(() => {
      expect(postCalls).toHaveLength(1);
    });
    expect(postCalls[0]?.body.conversationId).toBe("conv-fresh");
    expect(postCalls[0]?.body.hidden).toBe(true);

    act(() => {
      result.current.reset();
    });
  });

  test("re-posts on resume when the turn never started", async () => {
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
        resumeConversationId: "conv-resumed",
      });
    });

    await waitFor(() => {
      expect(postCalls).toHaveLength(1);
    });
    expect(postCalls[0]?.body.conversationId).toBe("conv-resumed");

    act(() => {
      result.current.reset();
    });
  });

  test("does not re-post on resume while the turn is still processing", async () => {
    // The regression the hidden flag would otherwise cause: the prompt row is
    // filtered from `/messages`, so a user-row check would read "never landed"
    // and fire a second research turn on every refresh.
    listed = { processing: true, messages: [] };
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
        resumeConversationId: "conv-resumed",
      });
    });

    await whenResumeDecided();
    expect(postCalls).toHaveLength(0);

    act(() => {
      result.current.reset();
    });
  });

  test("does not re-post on resume when the turn already produced rows", async () => {
    listed = {
      processing: false,
      messages: [{ role: "assistant", contentBlocks: [] }],
    };
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
        resumeConversationId: "conv-resumed",
      });
    });

    await whenResumeDecided();
    expect(postCalls).toHaveLength(0);

    act(() => {
      result.current.reset();
    });
  });
});

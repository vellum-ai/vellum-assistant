import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";

// Controllable stub for the streaming client.
interface StreamCall {
  assistantId: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

const streamCalls: StreamCall[] = [];
let streamImpl: (opts: StreamCall) => Promise<string> = async () => "Hello there";

mock.module("@/domains/chat/api/stream-greeting", () => ({
  streamEmptyStateGreeting: (opts: StreamCall) => {
    streamCalls.push(opts);
    return streamImpl(opts);
  },
}));

import { useEmptyStateGreeting } from "@/domains/chat/hooks/use-empty-state-greeting";

beforeEach(() => {
  streamCalls.length = 0;
  streamImpl = async () => "Hello there";
});

afterEach(() => {
  cleanup();
});

describe("useEmptyStateGreeting", () => {
  test("returns the default and does not generate when disabled", () => {
    const { result } = renderHook(() =>
      useEmptyStateGreeting({
        assistantId: "a1",
        conversationId: "c1",
        enabled: false,
      }),
    );

    expect(result.current.greeting).toBe(DEFAULT_EMPTY_STATE_GREETING);
    expect(result.current.isGenerating).toBe(false);
    expect(streamCalls).toHaveLength(0);
  });

  test("does not generate without an assistant or conversation id", () => {
    renderHook(() =>
      useEmptyStateGreeting({ assistantId: null, conversationId: "c1" }),
    );
    expect(streamCalls).toHaveLength(0);
  });

  test("streams a greeting and renders it", async () => {
    streamImpl = async (opts) => {
      opts.onDelta?.("Hey");
      opts.onDelta?.("Hey there");
      return "Hey there";
    };

    const { result } = renderHook(() =>
      useEmptyStateGreeting({ assistantId: "a1", conversationId: "c1" }),
    );

    await waitFor(() => {
      expect(result.current.greeting).toBe("Hey there");
    });
    expect(result.current.isGenerating).toBe(false);
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]!.assistantId).toBe("a1");
  });

  test("falls back to the default greeting on error", async () => {
    streamImpl = async () => {
      throw new Error("network");
    };

    const { result } = renderHook(() =>
      useEmptyStateGreeting({ assistantId: "a1", conversationId: "c1" }),
    );

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });
    expect(result.current.greeting).toBe(DEFAULT_EMPTY_STATE_GREETING);
  });

  test("regenerates when the conversation id changes", async () => {
    const { rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useEmptyStateGreeting({ assistantId: "a1", conversationId }),
      { initialProps: { conversationId: "c1" } },
    );

    await waitFor(() => expect(streamCalls).toHaveLength(1));

    rerender({ conversationId: "c2" });

    await waitFor(() => expect(streamCalls).toHaveLength(2));
  });
});

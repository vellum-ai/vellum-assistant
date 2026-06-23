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

import {
  greetingCacheMap,
  GREETING_POOL_SIZE,
  useEmptyStateGreeting,
} from "@/domains/chat/hooks/use-empty-state-greeting";

beforeEach(() => {
  streamCalls.length = 0;
  streamImpl = async () => "Hello there";
  greetingCacheMap.clear();
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

  test("fires 5 parallel requests to populate the greeting pool", async () => {
    let callCount = 0;
    streamImpl = async () => {
      callCount++;
      return `Greeting ${callCount}`;
    };

    const { result } = renderHook(() =>
      useEmptyStateGreeting({ assistantId: "a1", conversationId: "c1" }),
    );

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    expect(streamCalls).toHaveLength(GREETING_POOL_SIZE);
    expect(greetingCacheMap.get("a1")!.greetings.length).toBeGreaterThan(0);
  });

  test("renders the first completed greeting while others load", async () => {
    streamImpl = async () => "Hey friend";

    const { result } = renderHook(() =>
      useEmptyStateGreeting({ assistantId: "a1", conversationId: "c1" }),
    );

    await waitFor(() => {
      expect(result.current.greeting).toBe("Hey friend");
    });
    expect(result.current.isGenerating).toBe(false);
  });

  test("uses cached greeting on subsequent conversation changes", async () => {
    // Pre-populate the cache
    greetingCacheMap.set("a1", {
      greetings: ["Cached one", "Cached two", "Cached three", "Cached four", "Cached five"],
      loading: false,
    });

    const { result } = renderHook(() =>
      useEmptyStateGreeting({ assistantId: "a1", conversationId: "c2" }),
    );

    // Should immediately pick from cache — no new stream calls
    expect(streamCalls).toHaveLength(0);
    expect(result.current.isGenerating).toBe(false);
    expect(["Cached one", "Cached two", "Cached three", "Cached four", "Cached five"]).toContain(
      result.current.greeting,
    );
  });

  test("does not re-fetch when cache is already full", async () => {
    greetingCacheMap.set("a1", {
      greetings: ["G1", "G2", "G3", "G4", "G5"],
      loading: false,
    });

    renderHook(() =>
      useEmptyStateGreeting({ assistantId: "a1", conversationId: "c1" }),
    );

    // No new network requests should be made
    expect(streamCalls).toHaveLength(0);
  });

  test("falls back to the default greeting when all requests fail", async () => {
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

  test("picks a different random greeting on conversation id change with warm cache", async () => {
    greetingCacheMap.set("a1", {
      greetings: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"],
      loading: false,
    });

    const allPicks = new Set<string>();

    // Render many times with different conversation ids to verify randomness
    for (let i = 0; i < 20; i++) {
      const { result, unmount } = renderHook(() =>
        useEmptyStateGreeting({ assistantId: "a1", conversationId: `c${i}` }),
      );
      allPicks.add(result.current.greeting);
      unmount();
    }

    // With 5 options and 20 attempts, we should see at least 2 different greetings
    expect(allPicks.size).toBeGreaterThan(1);
    for (const pick of allPicks) {
      expect(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]).toContain(pick);
    }
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";

// Controllable stub for the greeting pool fetcher.
interface FetchCall {
  assistantId: string;
  signal?: AbortSignal;
}

const fetchCalls: FetchCall[] = [];
let fetchImpl: (opts: FetchCall) => Promise<string[]> = async () => [
  "Hey there",
  "What's up",
  "Hi friend",
  "Good to see you",
  "Hey!",
];

mock.module("@/domains/chat/api/stream-greeting", () => ({
  fetchGreetingPool: (opts: FetchCall) => {
    fetchCalls.push(opts);
    return fetchImpl(opts);
  },
}));

import {
  greetingCacheMap,
  useEmptyStateGreeting,
} from "@/domains/chat/hooks/use-empty-state-greeting";

beforeEach(() => {
  fetchCalls.length = 0;
  fetchImpl = async () => [
    "Hey there",
    "What's up",
    "Hi friend",
    "Good to see you",
    "Hey!",
  ];
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
    expect(fetchCalls).toHaveLength(0);
  });

  test("does not generate without an assistant or conversation id", () => {
    renderHook(() =>
      useEmptyStateGreeting({ assistantId: null, conversationId: "c1" }),
    );
    expect(fetchCalls).toHaveLength(0);
  });

  test("fires a single request to fetch the greeting pool", async () => {
    const { result } = renderHook(() =>
      useEmptyStateGreeting({ assistantId: "a1", conversationId: "c1" }),
    );

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    expect(fetchCalls).toHaveLength(1);
    expect(greetingCacheMap.get("a1")!.greetings.length).toBe(5);
  });

  test("renders a greeting from the pool once loaded", async () => {
    fetchImpl = async () => ["Hey friend", "What's up", "Howdy"];

    const { result } = renderHook(() =>
      useEmptyStateGreeting({ assistantId: "a1", conversationId: "c1" }),
    );

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    expect(["Hey friend", "What's up", "Howdy"]).toContain(
      result.current.greeting,
    );
  });

  test("uses cached greeting on subsequent conversation changes", async () => {
    greetingCacheMap.set("a1", {
      greetings: ["Cached one", "Cached two", "Cached three", "Cached four", "Cached five"],
      loading: false,
    });

    const { result } = renderHook(() =>
      useEmptyStateGreeting({ assistantId: "a1", conversationId: "c2" }),
    );

    // Should immediately pick from cache — no new fetch calls
    expect(fetchCalls).toHaveLength(0);
    expect(result.current.isGenerating).toBe(false);
    expect(["Cached one", "Cached two", "Cached three", "Cached four", "Cached five"]).toContain(
      result.current.greeting,
    );
  });

  test("does not re-fetch when cache is already populated", async () => {
    greetingCacheMap.set("a1", {
      greetings: ["G1", "G2", "G3", "G4", "G5"],
      loading: false,
    });

    renderHook(() =>
      useEmptyStateGreeting({ assistantId: "a1", conversationId: "c1" }),
    );

    expect(fetchCalls).toHaveLength(0);
  });

  test("falls back to the default greeting when the request fails", async () => {
    fetchImpl = async () => {
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

    for (let i = 0; i < 20; i++) {
      const { result, unmount } = renderHook(() =>
        useEmptyStateGreeting({ assistantId: "a1", conversationId: `c${i}` }),
      );
      allPicks.add(result.current.greeting);
      unmount();
    }

    expect(allPicks.size).toBeGreaterThan(1);
    for (const pick of allPicks) {
      expect(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]).toContain(pick);
    }
  });
});

import { createElement } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test } from "bun:test";

import { MOCK_SUGGESTION_GROUPS } from "@/domains/chat/suggestions/mock-suggestions";
import { useThreadSuggestions } from "@/domains/chat/hooks/use-thread-suggestions";

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  };
}

afterEach(() => {
  cleanup();
});

describe("useThreadSuggestions", () => {
  test("falls back to mock data when assistantId is null", () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useThreadSuggestions(null), { wrapper });

    expect(result.current.featured).toHaveLength(3);
    expect(result.current.groups.length).toBe(MOCK_SUGGESTION_GROUPS.length);
    expect(result.current.groups).toBe(MOCK_SUGGESTION_GROUPS);
    expect(result.current.isLoading).toBe(false);
  });

  test("shows mock groups and is loading when assistantId is set but fetch not settled", () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useThreadSuggestions("test-assistant"), { wrapper });

    // Before the fetch resolves the hook falls back to mock groups.
    expect(result.current.groups).toBe(MOCK_SUGGESTION_GROUPS);
    expect(result.current.isLoading).toBe(true);
  });
});

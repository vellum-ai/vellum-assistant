import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { MOCK_SUGGESTION_GROUPS } from "@/domains/chat/suggestions/mock-suggestions";
import { useThreadSuggestions } from "@/domains/chat/hooks/use-thread-suggestions";

afterEach(() => {
  cleanup();
});

describe("useThreadSuggestions", () => {
  test("returns 3 featured suggestions and the mock groups", () => {
    const { result } = renderHook(() => useThreadSuggestions());

    expect(result.current.featured).toHaveLength(3);
    expect(result.current.groups.length).toBe(MOCK_SUGGESTION_GROUPS.length);
    expect(result.current.groups).toBe(MOCK_SUGGESTION_GROUPS);
  });

  test("returns a stable reference across re-renders", () => {
    const { result, rerender } = renderHook(() => useThreadSuggestions());

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });
});

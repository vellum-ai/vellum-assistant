import { afterEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useActiveAssistantId } from "./use-active-assistant-id";

afterEach(() => {
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("useActiveAssistantId", () => {
  test("returns the active id when the gate has resolved", () => {
    useResolvedAssistantsStore.getState().setActiveAssistantId("asst-1");
    const { result } = renderHook(() => useActiveAssistantId());
    expect(result.current).toBe("asst-1");
  });

  test("throws when read outside the gate (id is null)", () => {
    expect(() => {
      renderHook(() => useActiveAssistantId());
    }).toThrow(/ActiveAssistantGate/);
  });
});

import { describe, expect, it } from "bun:test";

import {
  areSelectionsEqual,
  canGoBack,
  canGoForward,
  INITIAL_NAVIGATION_STATE,
  navigationReducer,
  type NavigationHistoryState,
  type ViewSelection,
} from "@/domains/chat/lib/navigation-history.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateWith(
  overrides: Partial<NavigationHistoryState>,
): NavigationHistoryState {
  return { ...INITIAL_NAVIGATION_STATE, ...overrides };
}

// ---------------------------------------------------------------------------
// areSelectionsEqual
// ---------------------------------------------------------------------------

describe("areSelectionsEqual", () => {
  it("returns true for identical conversation selections", () => {
    const a: ViewSelection = { type: "conversation", key: "abc" };
    const b: ViewSelection = { type: "conversation", key: "abc" };
    expect(areSelectionsEqual(a, b)).toBe(true);
  });

  it("returns false for different conversation keys", () => {
    const a: ViewSelection = { type: "conversation", key: "abc" };
    const b: ViewSelection = { type: "conversation", key: "def" };
    expect(areSelectionsEqual(a, b)).toBe(false);
  });

  it("returns true for identical intelligence selections", () => {
    const a: ViewSelection = { type: "intelligence" };
    const b: ViewSelection = { type: "intelligence" };
    expect(areSelectionsEqual(a, b)).toBe(true);
  });

  it("returns true for library selections", () => {
    const a: ViewSelection = { type: "library" };
    const b: ViewSelection = { type: "library" };
    expect(areSelectionsEqual(a, b)).toBe(true);
  });

  it("returns true for identical app selections", () => {
    const a: ViewSelection = { type: "app", appId: "app-1" };
    const b: ViewSelection = { type: "app", appId: "app-1" };
    expect(areSelectionsEqual(a, b)).toBe(true);
  });

  it("returns false for different app selections", () => {
    const a: ViewSelection = { type: "app", appId: "app-1" };
    const b: ViewSelection = { type: "app", appId: "app-2" };
    expect(areSelectionsEqual(a, b)).toBe(false);
  });

  it("returns false for different types", () => {
    const a: ViewSelection = { type: "conversation", key: "abc" };
    const b: ViewSelection = { type: "library" };
    expect(areSelectionsEqual(a, b)).toBe(false);
  });

  it("returns true for two nulls", () => {
    expect(areSelectionsEqual(null, null)).toBe(true);
  });

  it("returns false when one is null", () => {
    expect(areSelectionsEqual(null, { type: "library" })).toBe(false);
    expect(areSelectionsEqual({ type: "library" }, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PUSH action
// ---------------------------------------------------------------------------

describe("navigationReducer — PUSH", () => {
  it("sets current from null without affecting back stack", () => {
    const state = INITIAL_NAVIGATION_STATE;
    const result = navigationReducer(state, {
      type: "PUSH",
      selection: { type: "conversation", key: "conv-1" },
    });

    expect(result.current).toEqual({ type: "conversation", key: "conv-1" });
    expect(result.backStack).toHaveLength(0);
    expect(result.forwardStack).toHaveLength(0);
  });

  it("pushes previous current onto back stack", () => {
    const state = stateWith({
      current: { type: "conversation", key: "conv-1" },
    });
    const result = navigationReducer(state, {
      type: "PUSH",
      selection: { type: "conversation", key: "conv-2" },
    });

    expect(result.current).toEqual({ type: "conversation", key: "conv-2" });
    expect(result.backStack).toEqual([{ type: "conversation", key: "conv-1" }]);
  });

  it("clears forward stack on push", () => {
    const state = stateWith({
      current: { type: "conversation", key: "conv-2" },
      backStack: [{ type: "conversation", key: "conv-1" }],
      forwardStack: [{ type: "conversation", key: "conv-3" }],
    });
    const result = navigationReducer(state, {
      type: "PUSH",
      selection: { type: "library" },
    });

    expect(result.current).toEqual({ type: "library" });
    expect(result.forwardStack).toHaveLength(0);
    expect(result.backStack).toEqual([
      { type: "conversation", key: "conv-1" },
      { type: "conversation", key: "conv-2" },
    ]);
  });

  it("is a no-op when pushing equivalent selection", () => {
    const state = stateWith({
      current: { type: "conversation", key: "conv-1" },
      backStack: [{ type: "library" }],
    });
    const result = navigationReducer(state, {
      type: "PUSH",
      selection: { type: "conversation", key: "conv-1" },
    });

    // State reference should be unchanged (identity equality)
    expect(result).toBe(state);
  });

});

// ---------------------------------------------------------------------------
// Max depth truncation
// ---------------------------------------------------------------------------

describe("navigationReducer — max depth truncation", () => {
  it("truncates back stack to 50 entries", () => {
    // Build a back stack with 50 items
    const backStack: ViewSelection[] = Array.from({ length: 50 }, (_, i) => ({
      type: "conversation" as const,
      key: `conv-${i}`,
    }));

    const state = stateWith({
      current: { type: "conversation", key: "conv-50" },
      backStack,
    });

    const result = navigationReducer(state, {
      type: "PUSH",
      selection: { type: "conversation", key: "conv-51" },
    });

    // Back stack should be capped at 50 (oldest entry dropped)
    expect(result.backStack).toHaveLength(50);
    // The oldest entry (conv-0) should be gone; conv-1 should be the oldest
    expect(result.backStack[0]).toEqual({
      type: "conversation",
      key: "conv-1",
    });
    // The newest should be conv-50
    expect(result.backStack[49]).toEqual({
      type: "conversation",
      key: "conv-50",
    });
  });

  it("truncates forward stack to 50 entries during POP_BACK", () => {
    const forwardStack: ViewSelection[] = Array.from(
      { length: 50 },
      (_, i) => ({
        type: "conversation" as const,
        key: `fwd-${i}`,
      }),
    );

    const state = stateWith({
      current: { type: "conversation", key: "current" },
      backStack: [{ type: "library" }],
      forwardStack,
    });

    const result = navigationReducer(state, { type: "POP_BACK" });

    // Forward stack should be capped at 50 (oldest entry dropped)
    expect(result.forwardStack).toHaveLength(50);
    // Oldest (fwd-0) should be gone
    expect(result.forwardStack[0]).toEqual({
      type: "conversation",
      key: "fwd-1",
    });
    // Newest should be "current" (just pushed)
    expect(result.forwardStack[49]).toEqual({
      type: "conversation",
      key: "current",
    });
  });
});

// ---------------------------------------------------------------------------
// POP_BACK action
// ---------------------------------------------------------------------------

describe("navigationReducer — POP_BACK", () => {
  it("is a no-op when back stack is empty", () => {
    const state = stateWith({
      current: { type: "conversation", key: "conv-1" },
    });
    const result = navigationReducer(state, { type: "POP_BACK" });
    expect(result).toBe(state);
  });

  it("pops from back stack and pushes current to forward stack", () => {
    const state = stateWith({
      current: { type: "conversation", key: "conv-2" },
      backStack: [{ type: "conversation", key: "conv-1" }],
      forwardStack: [],
    });
    const result = navigationReducer(state, { type: "POP_BACK" });

    expect(result.current).toEqual({ type: "conversation", key: "conv-1" });
    expect(result.backStack).toHaveLength(0);
    expect(result.forwardStack).toEqual([
      { type: "conversation", key: "conv-2" },
    ]);
  });

  it("preserves existing forward stack entries", () => {
    const state = stateWith({
      current: { type: "conversation", key: "conv-3" },
      backStack: [
        { type: "conversation", key: "conv-1" },
        { type: "conversation", key: "conv-2" },
      ],
      forwardStack: [{ type: "library" }],
    });
    const result = navigationReducer(state, { type: "POP_BACK" });

    expect(result.current).toEqual({ type: "conversation", key: "conv-2" });
    expect(result.backStack).toEqual([
      { type: "conversation", key: "conv-1" },
    ]);
    expect(result.forwardStack).toEqual([
      { type: "library" },
      { type: "conversation", key: "conv-3" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// POP_FORWARD action
// ---------------------------------------------------------------------------

describe("navigationReducer — POP_FORWARD", () => {
  it("is a no-op when forward stack is empty", () => {
    const state = stateWith({
      current: { type: "conversation", key: "conv-1" },
    });
    const result = navigationReducer(state, { type: "POP_FORWARD" });
    expect(result).toBe(state);
  });

  it("pops from forward stack and pushes current to back stack", () => {
    const state = stateWith({
      current: { type: "conversation", key: "conv-1" },
      backStack: [],
      forwardStack: [{ type: "conversation", key: "conv-2" }],
    });
    const result = navigationReducer(state, { type: "POP_FORWARD" });

    expect(result.current).toEqual({ type: "conversation", key: "conv-2" });
    expect(result.backStack).toEqual([
      { type: "conversation", key: "conv-1" },
    ]);
    expect(result.forwardStack).toHaveLength(0);
  });

  it("preserves existing back stack entries", () => {
    const state = stateWith({
      current: { type: "conversation", key: "conv-2" },
      backStack: [{ type: "library" }],
      forwardStack: [
        { type: "conversation", key: "conv-3" },
        { type: "conversation", key: "conv-4" },
      ],
    });
    const result = navigationReducer(state, { type: "POP_FORWARD" });

    expect(result.current).toEqual({ type: "conversation", key: "conv-4" });
    expect(result.backStack).toEqual([
      { type: "library" },
      { type: "conversation", key: "conv-2" },
    ]);
    expect(result.forwardStack).toEqual([
      { type: "conversation", key: "conv-3" },
    ]);
  });
});


// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

describe("canGoBack / canGoForward", () => {
  it("canGoBack is false with empty back stack", () => {
    expect(canGoBack(INITIAL_NAVIGATION_STATE)).toBe(false);
  });

  it("canGoBack is true with entries in back stack", () => {
    const state = stateWith({
      backStack: [{ type: "library" }],
    });
    expect(canGoBack(state)).toBe(true);
  });

  it("canGoForward is false with empty forward stack", () => {
    expect(canGoForward(INITIAL_NAVIGATION_STATE)).toBe(false);
  });

  it("canGoForward is true with entries in forward stack", () => {
    const state = stateWith({
      forwardStack: [{ type: "library" }],
    });
    expect(canGoForward(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: multi-step navigation flow
// ---------------------------------------------------------------------------

describe("navigation flow integration", () => {
  it("handles a full back-forward cycle", () => {
    let state = INITIAL_NAVIGATION_STATE;

    // Navigate: conv-1 -> conv-2 -> conv-3
    state = navigationReducer(state, {
      type: "PUSH",
      selection: { type: "conversation", key: "conv-1" },
    });
    state = navigationReducer(state, {
      type: "PUSH",
      selection: { type: "conversation", key: "conv-2" },
    });
    state = navigationReducer(state, {
      type: "PUSH",
      selection: { type: "conversation", key: "conv-3" },
    });

    expect(state.current).toEqual({ type: "conversation", key: "conv-3" });
    expect(state.backStack).toHaveLength(2);
    expect(canGoBack(state)).toBe(true);
    expect(canGoForward(state)).toBe(false);

    // Go back to conv-2
    state = navigationReducer(state, { type: "POP_BACK" });
    expect(state.current).toEqual({ type: "conversation", key: "conv-2" });
    expect(canGoBack(state)).toBe(true);
    expect(canGoForward(state)).toBe(true);

    // Go back to conv-1
    state = navigationReducer(state, { type: "POP_BACK" });
    expect(state.current).toEqual({ type: "conversation", key: "conv-1" });
    expect(canGoBack(state)).toBe(false);
    expect(canGoForward(state)).toBe(true);

    // Go forward to conv-2
    state = navigationReducer(state, { type: "POP_FORWARD" });
    expect(state.current).toEqual({ type: "conversation", key: "conv-2" });
    expect(canGoBack(state)).toBe(true);
    expect(canGoForward(state)).toBe(true);

    // Push new navigation — forward stack should be cleared
    state = navigationReducer(state, {
      type: "PUSH",
      selection: { type: "library" },
    });
    expect(state.current).toEqual({ type: "library" });
    expect(canGoForward(state)).toBe(false);
    expect(canGoBack(state)).toBe(true);
  });

});

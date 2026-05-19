/**
 * Navigation history state machine for Back/Forward tracking.
 *
 * Mirrors the macOS NavigationHistory.swift pattern: maintains a back stack
 * and forward stack of ViewSelections, with push/pop operations that enable
 * browser-style Back/Forward navigation between views.
 *
 * The core state machine is a pure reducer with no DOM/React dependencies.
 * The React hook (`useNavigationHistory`) wraps the reducer for component use.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ViewSelection =
  | { type: "conversation"; key: string }
  | { type: "intelligence" }
  | { type: "library" }
  | { type: "home" }
  | { type: "app"; appId: string }
  | { type: "document"; surfaceId: string; conversationId: string };

export interface NavigationHistoryState {
  current: ViewSelection | null;
  backStack: ViewSelection[];
  forwardStack: ViewSelection[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STACK_DEPTH = 50;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export const INITIAL_NAVIGATION_STATE: NavigationHistoryState = {
  current: null,
  backStack: [],
  forwardStack: [],
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type NavigationAction =
  | { type: "PUSH"; selection: ViewSelection }
  | { type: "REMAP_CONVERSATION_KEY"; oldKey: string; newKey: string }
  | { type: "POP_BACK" }
  | { type: "POP_FORWARD" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if two ViewSelections are semantically equivalent. */
export function areSelectionsEqual(
  a: ViewSelection | null,
  b: ViewSelection | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.type !== b.type) return false;

  switch (a.type) {
    case "conversation":
      return (
        b.type === "conversation" && a.key === (b as { key: string }).key
      );
    case "intelligence":
      return b.type === "intelligence";
    case "library":
      return b.type === "library";
    case "home":
      return b.type === "home";
    case "app":
      return (
        b.type === "app" && a.appId === (b as { appId: string }).appId
      );
    case "document":
      return (
        b.type === "document" &&
        a.surfaceId === (b as { surfaceId: string }).surfaceId &&
        a.conversationId === (b as { conversationId: string }).conversationId
      );
  }
}

/** Truncate a stack to the maximum depth, keeping the most recent entries. */
function truncateStack(stack: ViewSelection[]): ViewSelection[] {
  if (stack.length <= MAX_STACK_DEPTH) return stack;
  return stack.slice(stack.length - MAX_STACK_DEPTH);
}

// ---------------------------------------------------------------------------
// Reducer (pure function — no DOM/React dependency beyond types)
// ---------------------------------------------------------------------------

export function navigationReducer(
  state: NavigationHistoryState,
  action: NavigationAction,
): NavigationHistoryState {
  switch (action.type) {
    case "PUSH": {
      // If equivalent to current, skip (no-op)
      if (areSelectionsEqual(state.current, action.selection)) {
        return state;
      }

      // Push current to back stack (if we have a current), clear forward stack
      const newBackStack =
        state.current !== null
          ? truncateStack([...state.backStack, state.current])
          : state.backStack;

      return {
        ...state,
        current: action.selection,
        backStack: newBackStack,
        forwardStack: [],
      };
    }

    case "REMAP_CONVERSATION_KEY": {
      const remap = (s: ViewSelection): ViewSelection =>
        s.type === "conversation" && s.key === action.oldKey
          ? { type: "conversation", key: action.newKey }
          : s;
      const newCurrent = state.current ? remap(state.current) : null;
      const newBack = state.backStack.map(remap);
      const newFwd = state.forwardStack.map(remap);
      if (
        newCurrent === state.current &&
        newBack.every((s, i) => s === state.backStack[i]) &&
        newFwd.every((s, i) => s === state.forwardStack[i])
      ) {
        return state;
      }
      return { current: newCurrent, backStack: newBack, forwardStack: newFwd };
    }

    case "POP_BACK": {
      if (state.backStack.length === 0) return state;

      const newBackStack = [...state.backStack];
      const previous = newBackStack.pop()!;

      const newForwardStack =
        state.current !== null
          ? truncateStack([...state.forwardStack, state.current])
          : state.forwardStack;

      return {
        ...state,
        current: previous,
        backStack: newBackStack,
        forwardStack: newForwardStack,
      };
    }

    case "POP_FORWARD": {
      if (state.forwardStack.length === 0) return state;

      const newForwardStack = [...state.forwardStack];
      const next = newForwardStack.pop()!;

      const newBackStack =
        state.current !== null
          ? truncateStack([...state.backStack, state.current])
          : state.backStack;

      return {
        ...state,
        current: next,
        backStack: newBackStack,
        forwardStack: newForwardStack,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

export function canGoBack(state: NavigationHistoryState): boolean {
  return state.backStack.length > 0;
}

export function canGoForward(state: NavigationHistoryState): boolean {
  return state.forwardStack.length > 0;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export interface UseNavigationHistoryReturn {
  canGoBack: boolean;
  canGoForward: boolean;
  push: (selection: ViewSelection) => void;
  remapConversationKey: (oldKey: string, newKey: string) => void;
  goBack: () => ViewSelection | null;
  goForward: () => ViewSelection | null;
}

export function useNavigationHistory(): UseNavigationHistoryReturn {
  const [state, dispatch] = useReducer(
    navigationReducer,
    INITIAL_NAVIGATION_STATE,
  );

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const push = useCallback((selection: ViewSelection) => {
    dispatch({ type: "PUSH", selection });
  }, []);

  const remapConversationKey = useCallback((oldKey: string, newKey: string) => {
    dispatch({ type: "REMAP_CONVERSATION_KEY", oldKey, newKey });
  }, []);

  const goBack = useCallback((): ViewSelection | null => {
    const s = stateRef.current;
    if (s.backStack.length === 0) return null;
    const previous = s.backStack[s.backStack.length - 1]!;
    dispatch({ type: "POP_BACK" });
    return previous;
  }, []);

  const goForward = useCallback((): ViewSelection | null => {
    const s = stateRef.current;
    if (s.forwardStack.length === 0) return null;
    const next = s.forwardStack[s.forwardStack.length - 1]!;
    dispatch({ type: "POP_FORWARD" });
    return next;
  }, []);

  return {
    canGoBack: canGoBack(state),
    canGoForward: canGoForward(state),
    push,
    remapConversationKey,
    goBack,
    goForward,
  };
}

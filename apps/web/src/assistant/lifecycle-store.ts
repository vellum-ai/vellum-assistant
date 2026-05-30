/**
 * Assistant lifecycle state — the data side of `use-lifecycle.ts`.
 *
 * `use-lifecycle.ts` runs the behavior (mount-time init, polling,
 * recovery timers, mutation calls). This store holds the state it
 * produces: the discriminated `AssistantState` and the hook's
 * imperative callbacks.
 *
 * The store-not-context choice: every page that decides "what should
 * I render right now?" reads `assistantState`. Pushing it through
 * outlet context forces a bundled value through every layout layer
 * and re-renders every consumer on any field change. Atomic Zustand
 * selectors mean a route reading only `checkAssistant` doesn't
 * re-render when the state machine transitions. See
 * `apps/web/docs/STATE_MANAGEMENT.md` for the boundary rule.
 *
 * **Reading the imperative actions: call them inline via
 * `.getState()` at the use site.** The store ships no-op defaults
 * that `useAssistantLifecycle` overwrites in a passive `useEffect`
 * after its first render — children of `RootLayout` render in the
 * same commit, so neither render-time capture nor selector
 * subscription is right:
 *
 *   - `const fn = useAssistantLifecycleStore.getState().checkAssistant`
 *     at render time captures the no-op and never updates.
 *   - `const fn = useAssistantLifecycleStore.use.checkAssistant()`
 *     re-renders when registration lands; if `fn` is in any effect's
 *     dep list, the effect cleans up and re-runs after the identity
 *     flip — which **re-executes any side effect the effect already
 *     started** (e.g. duplicate hatch requests).
 *
 * The right pattern is to call the store action inline at the moment
 * it's needed: `await useAssistantLifecycleStore.getState().checkAssistant()`.
 * For actions that need to flow through a prop boundary, wrap in a
 * stable `useCallback(() => useAssistantLifecycleStore.getState().X(),
 * [])` so the prop identity doesn't flip when registration lands.
 *
 * @see {@link ./use-lifecycle.ts}
 * @see {@link ./selection-store.ts}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

import type { AssistantState } from "./types";

interface LifecycleState {
  assistantState: AssistantState;
  /**
   * Imperative re-check from the server. Called by the
   * visibility-change handler in `useEventBusInit`, onboarding
   * pre-chat verification, and `chat-route-content` when maintenance
   * mode exits.
   */
  checkAssistant: () => Promise<void>;
  /**
   * Reset both retry budgets and re-check. For the error-screen
   * "Try again" button.
   */
  retryAssistant: () => void;
  /**
   * Reset hatch retries and hatch with the given version. For the
   * version-selection screen in nonprod.
   */
  hatchVersion: (version?: string) => void;
}

interface LifecycleActions {
  setAssistantState: (state: AssistantState) => void;
  /**
   * Called once by `useAssistantLifecycle` after mount to expose the
   * stable callback references. Registering here keeps the hook the
   * single owner of the closures (so they see fresh React state and
   * the latest mutations) while letting any consumer call them
   * without prop drilling.
   */
  registerImperativeActions: (
    actions: Pick<
      LifecycleState,
      "checkAssistant" | "retryAssistant" | "hatchVersion"
    >,
  ) => void;
}

type LifecycleStore = LifecycleState & LifecycleActions;

// No-op defaults cover the brief pre-registration window between
// `RootLayout` mounting and `useAssistantLifecycle` running its
// register-actions effect. In practice a real route never observes
// these (renders are downstream of `RootLayout`), but typing the
// actions as non-nullable keeps every call site free of `?.()`
// guards and `!` assertions.
const NOOP_CHECK = async () => {};
const NOOP_VOID = () => {};

const useAssistantLifecycleStoreBase = create<LifecycleStore>((set) => ({
  assistantState: { kind: "loading" },
  checkAssistant: NOOP_CHECK,
  retryAssistant: NOOP_VOID,
  hatchVersion: NOOP_VOID,

  setAssistantState: (assistantState) => set({ assistantState }),
  registerImperativeActions: ({ checkAssistant, retryAssistant, hatchVersion }) =>
    set({ checkAssistant, retryAssistant, hatchVersion }),
}));

export const useAssistantLifecycleStore = createSelectors(
  useAssistantLifecycleStoreBase,
);

/**
 * Assistant lifecycle state machine — the data side.
 *
 * `use-lifecycle.ts` owns the *behavior* (mount-time init, polling,
 * recovery timers, mutation calls). This store owns the *state* it
 * produces: the discriminated `AssistantState` that drives top-level
 * page rendering, and stable references to the hook's imperative
 * callbacks (`checkAssistant`, `retryAssistant`, `hatchVersion`).
 *
 * Why a store instead of outlet context: every page that decides
 * "what should I render right now?" reads `assistantState`. Outlet
 * context forces a single bundled value through every layout layer
 * and re-renders every consumer when *any* field changes. Atomic
 * selectors here (`useAssistantLifecycleStore.use.assistantState()`)
 * mean a route reading only `checkAssistant` doesn't re-render when
 * the state machine transitions.
 *
 * The imperative-action fields are nullable refs registered by the
 * hook in a `useEffect` after mount. They stay `null` only during
 * the brief window between the React tree mounting and the hook's
 * first effect running — in practice never observable from a real
 * route, which renders after `RootLayout` mounts. Consumers call
 * through `.getState()` in callbacks (no subscription needed since
 * action identities are stable after registration).
 *
 * @see {@link ./use-lifecycle.ts} for the orchestrator that writes
 * here.
 * @see {@link ./selection-store.ts} for the active-assistant id,
 * which the lifecycle hook writes in lockstep with this store.
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

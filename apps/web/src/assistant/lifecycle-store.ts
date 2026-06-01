/**
 * Assistant lifecycle state — the data side of the lifecycle service.
 *
 * `lifecycle-service.ts` owns the behavior (state machine, polling
 * reactions, recovery, retry budgets, mutation calls). This store
 * holds the observable result: the discriminated `AssistantState`
 * the React tree subscribes to, plus a one-shot `autoGreetPending`
 * signal the service sets after a fresh hatch.
 *
 * The store-not-context choice: every page that decides "what
 * should I render right now?" reads `assistantState`. Pushing it
 * through outlet context forces a bundled value through every
 * layout layer and re-renders every consumer on any field change.
 * The atomic Zustand selector pattern avoids both costs. See
 * `apps/web/docs/STATE_MANAGEMENT.md`.
 *
 * Writers: only `lifecycle-service.ts` (the producer) and
 * `chat-page.tsx` (the `autoGreetPending` consumer, which clears
 * the flag after using it) should call
 * `useAssistantLifecycleStore.setState(...)`. Every other consumer
 * reads.
 *
 * @see {@link ./lifecycle-service.ts}
 * @see {@link ./selection-store.ts}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

import type { AssistantState } from "./types";

interface LifecycleState {
  assistantState: AssistantState;
  /**
   * Set to `true` by the service when an auto-hatch or version-hatch
   * succeeds — signals downstream chat code that the next available
   * conversation should auto-greet. One-shot: the consumer clears
   * the flag after consuming it so a subsequent navigation doesn't
   * re-trigger the greet.
   */
  autoGreetPending: boolean;
}

const useAssistantLifecycleStoreBase = create<LifecycleState>(() => ({
  assistantState: { kind: "loading" },
  autoGreetPending: false,
}));

export const useAssistantLifecycleStore = createSelectors(
  useAssistantLifecycleStoreBase,
);

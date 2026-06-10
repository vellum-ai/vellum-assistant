/**
 * Assistant lifecycle state — the data side of the lifecycle service.
 *
 * `lifecycle-service.ts` owns the behavior (state machine, polling
 * reactions, recovery, retry budgets, mutation calls). This store
 * holds the observable result: the discriminated `AssistantState`
 * the React tree subscribes to.
 *
 * The store-not-context choice: every page that decides "what
 * should I render right now?" reads `assistantState`. Pushing it
 * through outlet context forces a bundled value through every
 * layout layer and re-renders every consumer on any field change.
 * The atomic Zustand selector pattern avoids both costs. See
 * `apps/web/docs/STATE_MANAGEMENT.md`.
 *
 * Writers: only `lifecycle-service.ts` should call
 * `useAssistantLifecycleStore.setState(...)`. Consumers read.
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
   * Assistant id safe to use for platform operational-status polling.
   *
   * During hatch / cleanup, the lifecycle service can know the server
   * assistant id before it is allowed to publish `activeAssistantId`.
   * Keeping this id here lets chrome-level diagnostics follow those
   * non-active phases without making feature code treat the assistant
   * as active early.
   */
  operationalStatusAssistantId: string | null;
  /**
   * Auto-greet one-shot: set when any hatch path completes, cleared
   * on chat-surface exit conditions (first message arrived, 10s
   * safety, conversation switch) or on terminal lifecycle transitions
   * (error/retired/logout).
   *
   * Lives in the store rather than as a private service field so
   * React consumers subscribe via atomic selector — producers can
   * fire from inside the ChatPage tree (e.g. the version-selection
   * screen, the pre-chat sessionStorage detector) and the gate updates
   * without needing a mount/remount. A non-reactive field would
   * force every producer to also flip a local mirror; this avoids
   * the mirror entirely.
   */
  expectingFirstMessage: boolean;
}

const useAssistantLifecycleStoreBase = create<LifecycleState>(() => ({
  assistantState: { kind: "loading" },
  operationalStatusAssistantId: null,
  expectingFirstMessage: false,
}));

export const useAssistantLifecycleStore = createSelectors(
  useAssistantLifecycleStoreBase,
);

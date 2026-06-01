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
   * One-shot signal: a fresh hatch just completed and the chat surface
   * should hold the auto-greet loading gate until the first message
   * arrives. Set on every hatch path (vanilla auto-hatch, nonprod
   * `hatchVersion`, onboarding hatching-screen, pre-chat-flow) via
   * `lifecycleService.markExpectingFirstMessage()`; cleared by the
   * chat surface on exit conditions (messages arrived, 10s safety,
   * conversation switch). Lives here rather than in `ChatPage`
   * useState because `useConversationLoader`'s post-hatch redirect
   * remounts ChatPage — store state survives the remount; component
   * state does not.
   */
  expectingFirstMessage: boolean;
}

const useAssistantLifecycleStoreBase = create<LifecycleState>(() => ({
  assistantState: { kind: "loading" },
  expectingFirstMessage: false,
}));

export const useAssistantLifecycleStore = createSelectors(
  useAssistantLifecycleStoreBase,
);

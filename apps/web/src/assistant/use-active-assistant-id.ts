/**
 * Type-safe accessor for the active assistant id inside
 * `ActiveAssistantGate`-guarded routes.
 *
 * The gate defers rendering its `<Outlet />` until the selection
 * store has a non-null id AND the lifecycle reaches `active`, so
 * every gated route can treat the id as `string`. This hook turns
 * the runtime guarantee into a type guarantee — and throws if
 * called outside the gate, which is the bug we want loud.
 *
 * Routes that intentionally render across pre-active states
 * (`ChatPage`, `DocumentViewerPage`) read the raw store via
 * `useResolvedAssistantsStore.use.activeAssistantId()` and handle
 * the null case themselves.
 */

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export function useActiveAssistantId(): string {
  const id = useResolvedAssistantsStore.use.activeAssistantId();
  if (!id) {
    throw new Error(
      "useActiveAssistantId() called outside ActiveAssistantGate — " +
        "either mount the route under <ActiveAssistantGate> or read the " +
        "raw store via useResolvedAssistantsStore.use.activeAssistantId().",
    );
  }
  return id;
}

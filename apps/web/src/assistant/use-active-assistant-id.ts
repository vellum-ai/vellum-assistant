/**
 * Type-safe accessor for the active assistant id inside
 * `ActiveAssistantGate`-guarded routes.
 *
 * The gate defers rendering its child `<Outlet />` until the
 * selection store has a non-null id AND the lifecycle reaches
 * `active`, so every gated route can safely treat the id as a
 * `string`. The selection store types it as `string | null`
 * (because pre-mount it's null), so callers would otherwise
 * either widen the type with `!` everywhere or add unreachable
 * null guards. This hook collapses both to a single assertion
 * that fires only if a caller mistakenly mounts outside the
 * gate.
 *
 * Use this in any route whose parent is `ActiveAssistantGate`
 * (intelligence pages, library, workspace, contacts, home,
 * identity, inspector). Routes that intentionally render across
 * pre-active states (`ChatPage`, `DocumentViewerPage`) read the
 * raw store via `useAssistantSelectionStore.use.activeAssistantId()`
 * and handle the null case themselves.
 */

import { useAssistantSelectionStore } from "@/assistant/selection-store";

export function useActiveAssistantId(): string {
  const id = useAssistantSelectionStore.use.activeAssistantId();
  if (!id) {
    throw new Error(
      "useActiveAssistantId() called outside ActiveAssistantGate — " +
        "either mount the route under <ActiveAssistantGate> or read the " +
        "raw store via useAssistantSelectionStore.use.activeAssistantId().",
    );
  }
  return id;
}

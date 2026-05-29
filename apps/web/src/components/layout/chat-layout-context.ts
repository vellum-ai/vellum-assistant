/**
 * Outlet context that lets routes under `ChatLayout` populate the
 * shared `ChatLayoutHeader`.
 *
 * `ChatLayout` owns three `useState`-backed slot fields (header
 * center, header right, search-icon handler) and exposes setters
 * through this context. Child routes register their content from a
 * `useEffect` and clear it on unmount. The pattern stays
 * intentionally low-tech — it's a slot/portal, not application
 * state — so we don't promote it to Zustand (a `ReactNode` slot is
 * not store-shaped data, and the React-state-via-setters pattern
 * is the React-idiomatic way to do header slots).
 *
 * The assistant lifecycle used to ride along here but lives in
 * `useAssistantLifecycleStore` and `useAssistantSelectionStore`
 * now — see `apps/web/src/assistant/lifecycle-store.ts`. The
 * context's only remaining job is header slot wiring, hence the
 * narrower name.
 *
 * References:
 * - https://reactrouter.com/start/framework/outlet
 * - https://reactrouter.com/start/framework/routing#layout-routes
 */
import type { ReactNode } from "react";
import { useOutletContext } from "react-router";

export interface ChatLayoutContextValue {
  setTopBarCenter: (node: ReactNode) => void;
  setTopBarRightSlot: (node: ReactNode) => void;
  setOnSearchClick: (cb: (() => void) | null) => void;
}

export function useChatLayoutContext(): ChatLayoutContextValue {
  return useOutletContext<ChatLayoutContextValue>();
}

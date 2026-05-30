/**
 * Outlet context that lets routes under `ChatLayout` populate the
 * shared `ChatLayoutHeader`.
 *
 * `ChatLayout` owns three `useState`-backed slot fields (header
 * center, header right, search-icon handler) and exposes setters
 * through this context. Child routes register their content from a
 * `useEffect` and clear it on unmount.
 *
 * Slots stay in outlet context rather than a Zustand store on
 * purpose: a `ReactNode` slot is component-shaped (closures,
 * children) not store-shaped, and the React-state-via-setters
 * pattern is the idiomatic React way to do header slots.
 * Application state (the assistant lifecycle, the active id) lives
 * in stores under `src/assistant/`.
 *
 * @see https://reactrouter.com/start/framework/outlet
 * @see https://reactrouter.com/start/framework/routing#layout-routes
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

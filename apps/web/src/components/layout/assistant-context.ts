/**
 * Typed outlet context for the assistant lifecycle and layout slot
 * registration.
 *
 * The assistant lifecycle lives in `useAssistantLifecycleStore`.
 * `ChatLayout` reads from the store via atomic selectors and
 * publishes a slice of those values plus its layout-slot setters as
 * `AssistantContextValue` for its child routes, which consume it
 * through `useAssistantContext()`.
 *
 * Layout slot setters (`setTopBarCenter`, `setTopBarRightSlot`) allow
 * child routes to register content for the header without prop drilling.
 * `ChatLayout` holds the slot state and passes it to `ChatLayoutHeader`;
 * child routes call the setters (typically via `useEffect`) to fill them.
 * When a child route unmounts its cleanup effect clears the slots.
 *
 * References:
 * - https://reactrouter.com/start/framework/outlet
 * - https://reactrouter.com/start/framework/routing#layout-routes
 */
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import { useOutletContext } from "react-router";

import type {
  AssistantState,
  AssistantLifecycleStore,
} from "@/stores/assistant-lifecycle-store.js";

export interface AssistantContextValue {
  assistantId: string | null;
  assistantState: AssistantState;
  checkAssistant: AssistantLifecycleStore["checkAssistant"];
  retryAssistant: AssistantLifecycleStore["retryAssistant"];
  hatchVersion: AssistantLifecycleStore["hatchVersion"];
  /** Accepts a value or an updater function — same shape as
   *  `React.useState`'s setter so call sites can pass either form. */
  setAssistantId: Dispatch<SetStateAction<string | null>>;
  /** Stable ref whose `.current` mirrors the store's `autoGreet`
   *  flag. Kept on the context for shape parity with existing
   *  consumers; the source of truth is the store. */
  autoGreetRef: MutableRefObject<boolean>;
  setTopBarCenter: (node: ReactNode) => void;
  setTopBarRightSlot: (node: ReactNode) => void;
  setOnSearchClick: (cb: (() => void) | null) => void;
  setFooterBanner: (node: ReactNode) => void;
}

export function useAssistantContext(): AssistantContextValue {
  return useOutletContext<AssistantContextValue>();
}

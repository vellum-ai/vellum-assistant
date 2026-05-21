/**
 * Typed outlet context for the assistant lifecycle and layout slot
 * registration.
 *
 * `ChatLayout` owns `useAssistantLifecycle` and passes the resolved
 * assistant state to all child routes via React Router's outlet context.
 * Child routes consume it through `useAssistantContext()`.
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
import type { ReactNode } from "react";
import { useOutletContext } from "react-router";

import type {
  AssistantState,
  UseAssistantLifecycleReturn,
} from "@/domains/chat/hooks/use-assistant-lifecycle.js";

export interface AssistantContextValue {
  assistantId: string | null;
  assistantState: AssistantState;
  checkAssistant: UseAssistantLifecycleReturn["checkAssistant"];
  retryAssistant: UseAssistantLifecycleReturn["retryAssistant"];
  hatchVersion: UseAssistantLifecycleReturn["hatchVersion"];
  setAssistantId: UseAssistantLifecycleReturn["setAssistantId"];
  autoGreetRef: UseAssistantLifecycleReturn["autoGreetRef"];
  setTopBarCenter: (node: ReactNode) => void;
  setTopBarRightSlot: (node: ReactNode) => void;
  setOnSearchClick: (cb: (() => void) | null) => void;
  setFooterBanner: (node: ReactNode) => void;
}

export function useAssistantContext(): AssistantContextValue {
  return useOutletContext<AssistantContextValue>();
}

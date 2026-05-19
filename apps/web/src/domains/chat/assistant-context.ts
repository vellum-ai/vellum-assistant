/**
 * Typed outlet context for the assistant lifecycle.
 *
 * `ChatLayout` owns `useAssistantLifecycle` and passes the resolved
 * assistant state to all child routes via React Router's outlet context.
 * Child routes consume it through `useAssistantContext()`.
 *
 * References:
 * - https://reactrouter.com/start/framework/outlet
 * - https://reactrouter.com/start/framework/routing#layout-routes
 */
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
}

export function useAssistantContext(): AssistantContextValue {
  return useOutletContext<AssistantContextValue>();
}

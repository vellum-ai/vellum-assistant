import { Loader2 } from "lucide-react";
import { Outlet, useOutletContext } from "react-router";

import { Typography } from "@vellum/design-library";

import {
  useAssistantContext,
  type AssistantContextValue,
} from "@/components/layout/assistant-context";
import { useAssistantSelectionStore } from "@/stores/assistant-selection-store";

/**
 * Narrowed outlet context for routes mounted inside `ActiveAssistantGate`.
 * Guarantees `assistantId: string` (non-null) and that the daemon is
 * reachable (`assistantState.kind === "active"`).
 */
export interface ActiveAssistantContextValue extends AssistantContextValue {
  assistantId: string;
}

/**
 * Layout route that defers rendering of its child `<Outlet />` until the
 * assistant lifecycle has resolved: `assistantId` is non-null AND
 * `assistantState.kind === "active"`. Until both are true a single
 * placeholder is rendered.
 *
 * Without this gate, every route component that reads `assistantId` from
 * the outlet context and feeds it to a `useQuery` (e.g. home, identity,
 * library, workspace, contacts) suffers a silent-degradation bug on cold
 * navigation: the query stays `enabled: false`, `isLoading` is false, and
 * the page renders its fully-empty fallback state instead of waiting.
 *
 * Inside this gate, child routes call `useActiveAssistantContext()`
 * to read the narrowed context. Non-gated routes that need the same id
 * read directly from `useAssistantSelectionStore.use.activeAssistantId()`.
 */
export function ActiveAssistantGate() {
  const ctx = useAssistantContext();
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();

  if (!assistantId || ctx.assistantState.kind !== "active") {
    return <ActiveAssistantPlaceholder />;
  }

  const activeCtx: ActiveAssistantContextValue = {
    ...ctx,
    assistantId,
  };

  return <Outlet context={activeCtx} />;
}

export function useActiveAssistantContext(): ActiveAssistantContextValue {
  return useOutletContext<ActiveAssistantContextValue>();
}

function ActiveAssistantPlaceholder() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[var(--app-spacing-md)] text-[var(--content-tertiary)]"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-6 animate-spin" aria-hidden="true" />
      <Typography variant="body-medium-default">
        Connecting to your assistant…
      </Typography>
    </div>
  );
}

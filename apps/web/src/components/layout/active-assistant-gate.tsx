import { Loader2 } from "lucide-react";
import { Outlet, useNavigate } from "react-router";

import { Typography } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { handleLogout } from "@/lib/auth/handle-logout";
import { isLocalMode } from "@/lib/local-mode";
import { useHasPlatformSession } from "@/stores/auth-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * Layout route that defers rendering of its child `<Outlet />` until
 * the assistant lifecycle has resolved: the selection store has a
 * non-null `activeAssistantId` AND the lifecycle store reports
 * `assistantState.kind` is `"active"` or `"self_hosted"`. Until both
 * are true a placeholder is rendered.
 *
 * Without this gate, every route that reads `activeAssistantId` from
 * the store and feeds it to a `useQuery` (e.g. home, identity,
 * library, workspace, contacts, intelligence) suffers a
 * silent-degradation bug on cold navigation: the query stays
 * `enabled: false`, `isLoading` is false, and the page renders its
 * fully-empty fallback state instead of waiting for the lifecycle to
 * resolve.
 *
 * Inside this gate, child routes use `useActiveAssistantId()` from
 * `@/assistant/use-active-assistant-id` to read a non-null
 * `assistantId: string`. Non-gated routes (`ChatPage`,
 * `DocumentViewerPage`) intentionally render across pre-active
 * lifecycle states and read `useResolvedAssistantsStore.use.activeAssistantId()`
 * directly, handling the null case themselves.
 */
export function ActiveAssistantGate() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );

  if (!assistantId || (assistantStateKind !== "active" && assistantStateKind !== "self_hosted")) {
    return <ActiveAssistantPlaceholder />;
  }

  return <Outlet />;
}

function ActiveAssistantPlaceholder() {
  const navigate = useNavigate();
  // Keep an escape hatch reachable while the assistant lifecycle is
  // unresolved: hide in pure local mode unless a platform session exists.
  const hasPlatformSession = useHasPlatformSession();
  const showLogout = !isLocalMode() || hasPlatformSession;

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
      {showLogout && (
        <Button variant="ghost" onClick={() => void handleLogout(navigate)}>
          Log Out
        </Button>
      )}
    </div>
  );
}

/**
 * Applies the assistant's workspace theme (design-token overrides authored in
 * `ui/theme.json`) on top of the active light/dark/velvet base theme, and
 * keeps it live across multi-client edits.
 *
 * Mounted once from the root layout. Three responsibilities:
 *
 *  1. Fetch the validated theme from `GET /v1/workspace/theme` and push its
 *     token overrides onto the document root. Deliberately not version-gated:
 *     an assistant without the route (older, or rolled back from a themed
 *     version) 404s the read, which `fetchWorkspaceTheme` maps to the unthemed
 *     state so a rollback clears any applied theme rather than stranding a
 *     stale one — see "When a gate is unnecessary" in BACKWARDS_COMPAT.md.
 *  2. Refetch on the `assistant:self:theme` sync tag and on non-fresh SSE
 *     reconnect, so a theme the assistant (or another client) writes shows up
 *     without a reload — the daemon's config watcher emits the invalidation.
 *     Focus refetches are disabled: those are the only two change vectors.
 *  3. Surface a change made elsewhere as a small toast, the way an avatar or
 *     identity change is announced.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 */

import { useEffect } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellumai/design-library/components/toast";

import { workspaceThemeGet } from "@/generated/daemon/sdk.gen";
import { workspaceThemeGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { SYNC_TAGS } from "@/lib/sync/types";
import { getClientId } from "@/lib/telemetry/client-identity";
import {
  applyWorkspaceThemeTokens,
  type WorkspaceTheme,
} from "@/domains/settings/utils/workspace-theme-tokens";

/**
 * Read the validated workspace theme, mapping a 404 to the unthemed state.
 *
 * An assistant that lacks the route 404s this read, which resolves to `null` so
 * a refetch overwrites the last-applied theme instead of stranding it. Other
 * failures throw, so a transient error keeps the last-good theme and retries.
 */
export async function fetchWorkspaceTheme(
  assistantId: string,
  signal?: AbortSignal,
): Promise<WorkspaceTheme | null> {
  const { data, error, response } = await workspaceThemeGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
    signal,
  });
  if (!response || !response.ok) {
    if (response?.status === 404) {
      return null;
    }
    throw error ?? new Error("Failed to fetch workspace theme.");
  }
  return (data?.theme ?? null) as WorkspaceTheme | null;
}

export function useWorkspaceTheme(
  assistantId: string | null,
  isAssistantActive: boolean,
): void {
  const queryClient = useQueryClient();
  const enabled = isAssistantActive && !!assistantId;

  const { data: theme } = useQuery({
    queryKey: workspaceThemeGetQueryKey({
      path: { assistant_id: assistantId ?? "" },
    }),
    queryFn: ({ signal }) => fetchWorkspaceTheme(assistantId ?? "", signal),
    enabled,
    refetchOnWindowFocus: false,
  });

  // Apply on every resolved theme; clearing when the theme is removed, or when
  // the hook is disabled (assistant inactive / switched away), reverts to the
  // base-theme values. These vars live outside React on <html>, so a disabled
  // hook must actively clear a prior assistant's theme rather than leave it
  // applied. This hook is the sole writer of these vars.
  useEffect(() => {
    applyWorkspaceThemeTokens(enabled ? theme?.tokens : undefined);
  }, [enabled, theme]);

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: workspaceThemeGetQueryKey({
        path: { assistant_id: assistantId ?? "" },
      }),
    });
  };

  useBusSubscription("sse.event", (envelope) => {
    if (!enabled) {
      return;
    }
    const event = envelope.message;
    if (event.type !== "sync_changed") {
      return;
    }
    if (!event.tags.includes(SYNC_TAGS.assistantTheme)) {
      return;
    }
    invalidate();
    // A change from another client (or the assistant itself) is worth
    // announcing; a self-originated write already updated locally.
    if (event.originClientId && event.originClientId === getClientId()) {
      return;
    }
    toast.info("Theme updated");
  });

  useBusSubscription("sse.opened", ({ cause }) => {
    if (!enabled) {
      return;
    }
    if (cause === "fresh") {
      return;
    }
    invalidate();
  });
}

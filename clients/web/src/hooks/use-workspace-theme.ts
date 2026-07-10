/**
 * Applies the assistant's workspace theme (design-token overrides authored in
 * `ui/theme.json`) on top of the active light/dark/velvet base theme, and
 * keeps it live across multi-client edits.
 *
 * Mounted once from the root layout. Three responsibilities:
 *
 *  1. Fetch the validated theme from `GET /v1/workspace/theme` (version-gated;
 *     older assistants that lack the route apply nothing) and push its token
 *     overrides onto the document root.
 *  2. Refetch on the `assistant:self:theme` sync tag and on non-fresh SSE
 *     reconnect, so a theme the assistant (or another client) writes shows up
 *     without a reload — the daemon's config watcher emits the invalidation.
 *  3. Surface a change made elsewhere as a small toast, the way an avatar or
 *     identity change is announced.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - BACKWARDS_COMPAT.md — version gating
 */

import { useEffect } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellumai/design-library/components/toast";

import {
  workspaceThemeGetOptions,
  workspaceThemeGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useSupportsWorkspaceTheme } from "@/lib/backwards-compat/workspace-theme";
import { SYNC_TAGS } from "@/lib/sync/types";
import { getClientId } from "@/lib/telemetry/client-identity";
import {
  applyWorkspaceThemeTokens,
  type WorkspaceTheme,
} from "@/domains/settings/utils/workspace-theme-tokens";

export function useWorkspaceTheme(
  assistantId: string | null,
  isAssistantActive: boolean,
): void {
  const queryClient = useQueryClient();
  const supportsWorkspaceTheme = useSupportsWorkspaceTheme();
  const enabled = isAssistantActive && !!assistantId && supportsWorkspaceTheme;

  const { data } = useQuery({
    ...workspaceThemeGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled,
  });

  const theme = (data?.theme ?? null) as WorkspaceTheme | null;

  // Apply on every resolved theme; clearing when the theme is removed reverts
  // to the base-theme values. This hook is the sole writer of these vars.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    applyWorkspaceThemeTokens(theme?.tokens);
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

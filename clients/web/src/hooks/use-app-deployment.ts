/**
 * Read side of an app's Vercel deployment: whether it is already published
 * and, if so, where it lives.
 *
 * The deploy *write* path lives in {@link useDeployStore} (it owns the
 * in-flight dialogs and the publish request). The published URL is server
 * state, so it is read straight from its query cache rather than mirrored
 * into the store. See `docs/STATE_MANAGEMENT.md`.
 *
 * Surfaces that offer a deploy affordance (the app viewer's nav bar, the
 * library card's actions menu) call this so they can say "Deployed to
 * Vercel" and hand back the link instead of offering a first-time deploy
 * for an app that already has one.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  appsByIdPublishstatusGetOptions,
  appsByIdPublishstatusGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { useDeployStore } from "@/stores/deploy-store";
import { toast } from "@vellumai/design-library/components/toast";

export interface AppDeployment {
  /** Live URL of the active deployment, or `null` when nothing is published. */
  deployedUrl: string | null;
  /** True while the first status read for this app is still in flight. */
  isLoading: boolean;
}

/**
 * Report the active Vercel deployment for `appId`.
 *
 * `enabled` exists because the library renders one card per app: fetching a
 * status for every card on mount would be an N+1 against the daemon, so the
 * card only asks once its actions menu is reachable (hover / open).
 */
export function useAppDeployment(
  assistantId: string,
  appId: string | null,
  { enabled = true }: { enabled?: boolean } = {},
): AppDeployment {
  const queryClient = useQueryClient();
  const active = enabled && assistantId !== "" && appId != null;
  const path = { assistant_id: assistantId, id: appId ?? "" };

  const query = useQuery({
    ...appsByIdPublishstatusGetOptions({ path }),
    enabled: active,
  });

  // A publish rewrites the record this query reads, so refresh once the
  // deploy settles. `isDeploying` is a single global flag (the store admits
  // one deploy at a time), which is why the transition (not the value) is
  // the signal: every mounted status query refetches when any deploy ends.
  const isDeploying = useDeployStore.use.isDeploying();
  const wasDeploying = useRef(isDeploying);
  useEffect(() => {
    const settled = wasDeploying.current && !isDeploying;
    wasDeploying.current = isDeploying;
    if (settled && active) {
      void queryClient.invalidateQueries({
        queryKey: appsByIdPublishstatusGetQueryKey({
          path: { assistant_id: assistantId, id: appId ?? "" },
        }),
      });
    }
  }, [isDeploying, active, assistantId, appId, queryClient]);

  return {
    deployedUrl: query.data?.published ? (query.data.publicUrl ?? null) : null,
    isLoading: active && query.isPending,
  };
}

/**
 * Put a deployed app's URL on the clipboard and show it to the user.
 *
 * The toast carries the URL itself (the link is the point, and what the user
 * asked for) plus an Open action. The failure toast repeats the URL for the
 * same reason: a clipboard the browser refused shouldn't cost the user the
 * link they clicked for.
 */
export function copyDeployedAppLink(url: string): void {
  copyToClipboard(url, {
    errorMessage: `Couldn't copy the link. Open it at ${url}`,
    onCopied: () => {
      toast.success("Link copied", {
        description: url,
        action: {
          label: "Open",
          onClick: () => window.open(url, "_blank"),
        },
      });
    },
  });
}

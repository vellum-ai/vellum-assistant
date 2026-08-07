/**
 * A plugin channel's ingress approval, and the two decisions a guardian makes
 * about it.
 *
 * A plugin channel's routes are served only once a guardian approves the
 * declaration behind them. That state lives in the gateway, not the assistant,
 * which is why it is read here rather than alongside the channel list.
 *
 * Approving names the digest the listing reported. The gateway refuses a
 * digest that is not what the plugin declares right now, so a manifest that
 * changed between the read and the click is rejected rather than approved
 * sight unseen.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  assistantChannelIngressApproveMutation,
  assistantChannelIngressListOptions,
  assistantChannelIngressListQueryKey,
  assistantChannelIngressRevokeMutation,
} from "@/generated/gateway/@tanstack/react-query.gen";
import { httpStatusFromError, shouldRetryQuery } from "@/utils/query-retry";

export type IngressState = "approved" | "pending" | "none";

/** One declared address, and whether the approval decides anything for it. */
export interface IngressPath {
  path: string;
  /**
   * False for a `signer: "vellum"` route, which the gateway serves without an
   * approval and keeps serving after a revocation. Saying otherwise would tell
   * a guardian that public ingress is closed when it is open.
   */
  approvalGoverned: boolean;
}

export interface ChannelIngress {
  /** `none` when the gateway reports no declaration for this plugin at all. */
  state: IngressState;
  paths: IngressPath[];
  /** True while a decision is in flight. */
  deciding: boolean;
  /**
   * Whether this gateway can be asked at all. False only for the two answers
   * that mean "no decision exists here": a build predating the endpoint, and a
   * viewer who is not this assistant's guardian.
   */
  available: boolean;
  approve: () => void;
  revoke: () => void;
  /** A failure worth showing, as opposed to one that means "not available". */
  error: string | null;
}

/**
 * Statuses that mean the surface does not exist for this caller, rather than
 * that a request failed.
 *
 * A gateway predating the endpoint answers 404, and a viewer who is not the
 * bound guardian gets 401/403. Neither has a decision to offer, so the control
 * is absent rather than broken. Everything else, a 5xx or a network failure,
 * stays visible and reports itself: silently removing the approval on a blip
 * would tell a guardian there is nothing to decide.
 */
const SURFACE_ABSENT_STATUSES = new Set([401, 403, 404, 501]);

export function isSurfaceAbsent(error: unknown): boolean {
  const status = httpStatusFromError(error);
  return status !== undefined && SURFACE_ABSENT_STATUSES.has(status);
}

export function useChannelIngress(
  assistantId: string,
  plugin: string,
): ChannelIngress {
  const queryClient = useQueryClient();
  const path = { assistant_id: assistantId };

  const query = useQuery({
    ...assistantChannelIngressListOptions({ path }),
    enabled: Boolean(assistantId),
    retry: shouldRetryQuery,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: assistantChannelIngressListQueryKey({ path }),
    });

  const approval = useMutation({
    ...assistantChannelIngressApproveMutation(),
    onSuccess: invalidate,
  });
  const revocation = useMutation({
    ...assistantChannelIngressRevokeMutation(),
    onSuccess: invalidate,
  });

  const entry = query.data?.sources?.find((source) => source.source === plugin);
  const surfaceAbsent = query.isError && isSurfaceAbsent(query.error);
  const failure =
    approval.error ?? revocation.error ?? (surfaceAbsent ? null : query.error);

  return {
    state: entry ? entry.state : "none",
    paths:
      entry?.routes?.map((route) => ({
        path: route.publicPath,
        approvalGoverned: route.signer !== "vellum",
      })) ?? [],
    deciding: approval.isPending || revocation.isPending,
    available: !surfaceAbsent,
    approve: () => {
      if (entry?.digest) {
        approval.mutate({
          path: { ...path, source: plugin },
          body: { digest: entry.digest },
        });
      }
    },
    revoke: () => revocation.mutate({ path: { ...path, source: plugin } }),
    error: failure ? (failure.message ?? "Something went wrong") : null,
  };
}

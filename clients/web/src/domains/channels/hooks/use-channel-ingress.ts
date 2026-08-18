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

/**
 * What there is to say about a plugin channel's ingress, as one value.
 *
 * A single discriminant rather than a set of booleans a caller has to test in
 * the right order. Every reading is exactly one of these, so a panel cannot
 * report "no declaration" while a request is in flight or has failed, which is
 * the mistake the flags invited.
 *
 * - `loading`     still reading, nothing known yet
 * - `unsupported` this gateway has no ingress-approval endpoint
 * - `forbidden`   this viewer is not the assistant's guardian
 * - `unreadable`  the read failed; transient, and retried
 * - `none`        the gateway sees no declaration for this plugin
 * - `pending`     declared, awaiting a guardian
 * - `approved`    granted
 */
export type IngressStatus =
  | "loading"
  | "unsupported"
  | "forbidden"
  | "unreadable"
  | "none"
  | "pending"
  | "approved";

/** One declared address, and whether the approval decides anything for it. */
export interface IngressPath {
  path: string;
  /**
   * False for a `signer: "vellum"` route, which the gateway serves without an
   * approval and keeps serving after a revocation. Saying otherwise would tell
   * a guardian that public ingress is closed when it is open.
   */
  approvalGoverned: boolean;
  /**
   * True when what arrives here becomes a message to the assistant, rather
   * than a callback the plugin merely receives. Opening an address and letting
   * something start a conversation are different decisions, and only the
   * gateway knows which one a route is asking for.
   */
  deliversInbound: boolean;
}

export interface ChannelIngress {
  status: IngressStatus;
  paths: IngressPath[];
  /** True while a decision is in flight. */
  deciding: boolean;
  approve: () => void;
  revoke: () => void;
  /** A failure worth showing: a refused decision, or a failed read. */
  error: string | null;
}

/** A gateway with no such endpoint. */
const UNSUPPORTED_STATUSES = new Set([404, 501]);

/** A caller who is not this assistant's guardian. */
const FORBIDDEN_STATUSES = new Set([401, 403]);

/**
 * Why a read failed, in the terms the panel reports.
 *
 * The two are told apart rather than folded together, because the copy for
 * them differs and getting it wrong misinforms: "only the guardian can approve
 * this" is false when the viewer *is* the guardian and the gateway simply has
 * no such endpoint. Anything else is transient, so it reports itself and
 * retries instead of reading as a settled answer.
 */
export function classifyIngressFailure(
  error: unknown,
): "unsupported" | "forbidden" | "unreadable" {
  const status = httpStatusFromError(error);
  if (status !== undefined && UNSUPPORTED_STATUSES.has(status)) {
    return "unsupported";
  }
  if (status !== undefined && FORBIDDEN_STATUSES.has(status)) {
    return "forbidden";
  }
  return "unreadable";
}

/**
 * The failure the panel should report, given what it is about to say.
 *
 * A refused decision outlives the request that produced it: TanStack keeps a
 * mutation's error until it is reset or retried, so a rejected approval is
 * still hanging around when a later refetch fails. Preferring it there would
 * pair "could not read the ingress approval" with an unrelated sentence about
 * a digest mismatch. The read failure is the one that explains the state being
 * shown, so it wins whenever the state is the read failing; everywhere else
 * the decision is the only thing that can have gone wrong.
 *
 * Returns the text to show, or null when nothing failed.
 */
export function reportableError(
  status: IngressStatus,
  queryError: unknown,
  decisionError: unknown,
): string | null {
  const failure = status === "unreadable" ? queryError : decisionError;
  if (!failure) {
    return null;
  }
  return failure instanceof Error && failure.message
    ? failure.message
    : "Something went wrong";
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

  // Ordered so an unfinished or failed read can never be reported as a
  // settled answer about what the gateway declares.
  let status: IngressStatus;
  if (query.isError) {
    status = classifyIngressFailure(query.error);
  } else if (query.isPending) {
    status = "loading";
  } else {
    status = entry ? entry.state : "none";
  }

  const failure = reportableError(
    status,
    query.error,
    approval.error ?? revocation.error,
  );

  return {
    status,
    paths:
      entry?.routes?.map((route) => ({
        path: route.publicPath,
        approvalGoverned: route.signer !== "vellum",
        deliversInbound: route.deliversInbound === true,
      })) ?? [],
    deciding: approval.isPending || revocation.isPending,
    approve: () => {
      if (entry?.digest) {
        approval.mutate({
          path: { ...path, source: plugin },
          body: { digest: entry.digest },
        });
      }
    },
    revoke: () => revocation.mutate({ path: { ...path, source: plugin } }),
    error: failure,
  };
}

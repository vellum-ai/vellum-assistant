/**
 * A plugin channel's ingress approval, and the two decisions a guardian makes
 * about it.
 *
 * A plugin channel's routes are served only once a guardian approves the
 * declaration behind them, and until then every delivery is refused. That
 * state lives in the gateway, not the assistant, which is why it is read here
 * rather than alongside the channel list.
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

export type IngressState = "approved" | "pending" | "none";

export interface ChannelIngress {
  /** `none` when the gateway reports no declaration for this plugin at all. */
  state: IngressState;
  /** Digest to approve. Undefined when there is nothing declared. */
  digest?: string;
  /** Public paths the declaration would open, for the guardian to read. */
  paths: string[];
  /** True while a decision is in flight. */
  deciding: boolean;
  /** Whether the gateway could be asked at all (older ones have no endpoint). */
  available: boolean;
  approve: () => void;
  revoke: () => void;
  error: string | null;
}

/**
 * A gateway without the endpoint answers 404, and an assistant whose guardian
 * this viewer is not answers 403. Neither is worth an error banner on a
 * settings page: both mean "no decision to offer here", so the panel hides the
 * control rather than reporting a failure the viewer cannot act on.
 */
export function useChannelIngress(
  assistantId: string,
  plugin: string,
): ChannelIngress {
  const queryClient = useQueryClient();
  const path = { assistant_id: assistantId };

  const { data, isError } = useQuery({
    ...assistantChannelIngressListOptions({ path }),
    enabled: Boolean(assistantId),
    retry: false,
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

  const entry = data?.sources?.find((source) => source.source === plugin);
  const failure = approval.error ?? revocation.error;

  return {
    state: entry ? entry.state : "none",
    digest: entry?.digest,
    paths: entry?.routes?.map((route) => route.publicPath) ?? [],
    deciding: approval.isPending || revocation.isPending,
    available: !isError,
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

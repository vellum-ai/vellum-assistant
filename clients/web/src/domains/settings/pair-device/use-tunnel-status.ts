import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { integrationsIngressStatusGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { IntegrationsIngressStatusGetResponse } from "@/generated/daemon/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useSupportsIngressStatus } from "@/lib/backwards-compat/ingress-status-gate";

import type { TunnelStatusView } from "./tunnel-status-row";

export interface TunnelStatusController {
  /** What the card's tunnel status row should draw right now. */
  status: TunnelStatusView;
  /** A probe is in flight, whether the first one or a re-check. */
  isRefreshing: boolean;
  /** Re-runs the daemon-side probe; a no-op while the probe is gated off. */
  refresh: () => void;
}

/**
 * Asks the daemon whether this assistant's recorded public URL is actually
 * serving it, and shapes the answer for the Pair-a-device card's status row.
 *
 * The probe is a live network call on the daemon side, so its result is
 * never reused across mounts (`staleTime: 0`): every mount re-checks. Window
 * focus is deliberately not a TanStack refetch trigger; the card re-checks on
 * `app.resume` through the event bus, and letting both fire would double the
 * probes on every return to the tab.
 *
 * `enabled` is the caller's own condition (the card only probes when it is
 * rendering at all). It is ANDed with the version gate, so an assistant that
 * predates the route is never asked for it, and with org readiness, so the
 * request cannot go out before the `Vellum-Organization-Id` header exists.
 * Those three live in one `canProbe` boolean that drives both the query's
 * `enabled` option and `refresh`: TanStack's imperative `refetch()` ignores
 * `enabled`, so an unguarded `refresh` would let the `app.resume` handler
 * fire the probe past every safeguard, and one shared boolean keeps the two
 * from drifting apart.
 */
export function useTunnelStatus(enabled: boolean): TunnelStatusController {
  const assistantId = useActiveAssistantId();
  const supportsIngressStatus = useSupportsIngressStatus(assistantId);
  const isOrgReady = useIsOrgReady();
  const canProbe = enabled && supportsIngressStatus && isOrgReady;

  const { data, isFetching, refetch } = useQuery({
    ...integrationsIngressStatusGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: canProbe,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback(() => {
    if (!canProbe) {
      return;
    }
    void refetch();
  }, [canProbe, refetch]);

  return {
    status: toStatusView(data, isFetching),
    isRefreshing: isFetching,
    refresh,
  };
}

/**
 * Wire response to row state. The wire shape is flat (one optional field per
 * state) while the view is a union, so this narrows on `state` and drops the
 * fields that state does not populate.
 *
 * `lastTunnel` is carried onto the unhealthy states too, not just `stopped`:
 * a killed tunnel answers as `unreachable`, and the provider on record is
 * what lets the row print the command that starts it again.
 *
 * Only an answer the card never got becomes `unavailable`: no response with
 * nothing in flight, because the probe is gated off or the query exhausted
 * its retries. Every verdict the daemon does give stands, a `stopped` one
 * carrying no `lastTunnel` record included, since the card reads
 * `unavailable` as "the probe told us nothing" and falls back to the recorded
 * ingress URL this probe exists to replace.
 */
export function toStatusView(
  response: IntegrationsIngressStatusGetResponse | undefined,
  isFetching: boolean,
): TunnelStatusView {
  if (!response) {
    return isFetching ? { kind: "checking" } : { kind: "unavailable" };
  }

  const { lastTunnel } = response;
  // Both are set by the daemon for every probed state; the wire marks them
  // optional because the response is one flat object across all six.
  const publicBaseUrl = response.publicBaseUrl ?? "";
  const checkedAt = response.checkedAt ?? "";
  // Spread onto the states that take it optionally, so an absent record stays
  // an absent key rather than an explicit `undefined`.
  const recordedProvider = lastTunnel ? { provider: lastTunnel.provider } : {};

  switch (response.state) {
    case "unconfigured":
      return { kind: "unconfigured" };
    case "stopped":
      return {
        kind: "stopped",
        ...recordedProvider,
        ...(lastTunnel ? { publicBaseUrl: lastTunnel.publicBaseUrl } : {}),
      };
    case "healthy":
      return { kind: "healthy", publicBaseUrl, checkedAt };
    case "unpairable":
    case "unreachable":
      return {
        kind: response.state,
        publicBaseUrl,
        checkedAt,
        ...(response.detail ? { detail: response.detail } : {}),
        ...recordedProvider,
      };
    case "foreign":
      return {
        kind: "foreign",
        publicBaseUrl,
        checkedAt,
        ...(response.servingAssistantName
          ? { servingAssistantName: response.servingAssistantName }
          : {}),
        ...recordedProvider,
      };
    default:
      // A newer daemon can name a state this bundle predates. Falling off the
      // switch would return undefined and crash the row on `.kind`, so an
      // unknown verdict degrades to no verdict.
      return { kind: "unavailable" };
  }
}

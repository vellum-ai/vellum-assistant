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
  /** Re-runs the daemon-side probe. */
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
 */
export function useTunnelStatus(enabled: boolean): TunnelStatusController {
  const assistantId = useActiveAssistantId();
  const supportsIngressStatus = useSupportsIngressStatus();
  const isOrgReady = useIsOrgReady();

  const { data, isFetching, refetch } = useQuery({
    ...integrationsIngressStatusGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: enabled && supportsIngressStatus && isOrgReady,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

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
 * Degrades to `unconfigured` (which the row draws as nothing) whenever the
 * response cannot support a row: no answer yet with nothing in flight, or a
 * `stopped` verdict whose `lastTunnel` record is missing.
 */
export function toStatusView(
  response: IntegrationsIngressStatusGetResponse | undefined,
  isFetching: boolean,
): TunnelStatusView {
  if (!response) {
    return isFetching ? { kind: "checking" } : { kind: "unconfigured" };
  }

  // Both are set by the daemon for every probed state; the wire marks them
  // optional because the response is one flat object across all five.
  const publicBaseUrl = response.publicBaseUrl ?? "";
  const checkedAt = response.checkedAt ?? "";

  switch (response.state) {
    case "unconfigured":
      return { kind: "unconfigured" };
    case "stopped":
      return response.lastTunnel
        ? {
            kind: "stopped",
            provider: response.lastTunnel.provider,
            publicBaseUrl: response.lastTunnel.publicBaseUrl,
          }
        : { kind: "unconfigured" };
    case "healthy":
      return { kind: "healthy", publicBaseUrl, checkedAt };
    case "unreachable":
      return { kind: "unreachable", publicBaseUrl, checkedAt };
    case "foreign":
      return {
        kind: "foreign",
        publicBaseUrl,
        checkedAt,
        ...(response.servingAssistantName
          ? { servingAssistantName: response.servingAssistantName }
          : {}),
      };
  }
}

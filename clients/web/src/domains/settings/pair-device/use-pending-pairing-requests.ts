import { useCallback, useEffect, useRef, useState } from "react";

import type { RemoteWebPairingRequestSummary } from "@vellumai/service-contracts/remote-web-pairing";

import { captureError } from "@/lib/sentry/capture-error";

import {
  approvePairingRequest,
  denyPairingRequest,
  listPendingPairingRequests,
  PairDeviceError,
} from "./pair-device-client";

/** Matches the gateway store's recommended poll interval for pending requests. */
const POLL_INTERVAL_MS = 5000;

export type PendingPairingAction = "approve" | "deny";

/** Summaries are immutable per id, so id-sequence equality means unchanged. */
function sameRequestList(
  prev: RemoteWebPairingRequestSummary[],
  next: RemoteWebPairingRequestSummary[],
): boolean {
  return (
    prev.length === next.length &&
    next.every((request, i) => prev[i]?.requestId === request.requestId)
  );
}

export interface PendingPairingRequestsController {
  /** The pending pairing requests, as last fetched from the host gateway. */
  requests: RemoteWebPairingRequestSummary[];
  /** The request an approve/deny is currently in flight for, or `null`. */
  actingOn: { requestId: string; action: PendingPairingAction } | null;
  /** Non-fatal error message the card may surface, or `null`. */
  error: string | null;
  approve: (requestId: string) => Promise<void>;
  deny: (requestId: string) => Promise<void>;
}

/**
 * Polls the host gateway's loopback-only pending pairing-request list while
 * mounted and exposes approve/deny actions on the rows. `base` is the resolved
 * local-gateway base URL, or `null` when request approval isn't available from
 * here (outside desktop/local mode); the hook is then inert.
 *
 * A failed poll keeps the previous list (a transient loopback-proxy hiccup
 * shouldn't flash the UI empty) and records a non-fatal error instead. A
 * 404/410 from approve/deny means the request expired or was handled elsewhere
 * (the CLI `--web-approve` path can race the UI), so the row is removed as if
 * the action succeeded.
 */
export function usePendingPairingRequests(
  base: string | null,
): PendingPairingRequestsController {
  const [requests, setRequests] = useState<RemoteWebPairingRequestSummary[]>(
    [],
  );
  const [actingOn, setActingOn] = useState<{
    requestId: string;
    action: PendingPairingAction;
  } | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const pollAbortRef = useRef<AbortController | null>(null);
  const actionAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => actionAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!base) {
      return;
    }

    const poll = async () => {
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;
      try {
        const next = await listPendingPairingRequests({
          base,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        setRequests((prev) => (sameRequestList(prev, next) ? prev : next));
        setPollError(null);
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (err instanceof PairDeviceError) {
          setPollError(err.message);
          return;
        }
        captureError(err, { context: "pair-device-pending-requests-poll" });
        setPollError(
          "Something went wrong while checking for pairing requests.",
        );
      }
    };

    void poll();
    const intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(intervalId);
      pollAbortRef.current?.abort();
    };
  }, [base]);

  const runAction = useCallback(
    async (requestId: string, action: PendingPairingAction) => {
      if (!base || actionAbortRef.current) {
        return;
      }
      const controller = new AbortController();
      actionAbortRef.current = controller;
      setActingOn({ requestId, action });
      setActionError(null);

      const removeRequest = () => {
        // Abort any in-flight poll so a stale response can't resurrect the row.
        pollAbortRef.current?.abort();
        setRequests((prev) =>
          prev.filter((request) => request.requestId !== requestId),
        );
      };

      try {
        const perform =
          action === "approve" ? approvePairingRequest : denyPairingRequest;
        await perform({ base, requestId, signal: controller.signal });
        removeRequest();
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (err instanceof PairDeviceError) {
          if (err.status === 404 || err.status === 410) {
            // Expired or already handled elsewhere; treat as removed.
            removeRequest();
          } else {
            setActionError(err.message);
          }
        } else {
          captureError(err, { context: "pair-device-pending-request-action" });
          setActionError("Something went wrong. Try again.");
        }
      } finally {
        actionAbortRef.current = null;
        if (!controller.signal.aborted) {
          setActingOn(null);
        }
      }
    },
    [base],
  );

  const approve = useCallback(
    (requestId: string) => runAction(requestId, "approve"),
    [runAction],
  );
  const deny = useCallback(
    (requestId: string) => runAction(requestId, "deny"),
    [runAction],
  );

  return {
    requests,
    actingOn,
    error: actionError ?? pollError,
    approve,
    deny,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";

import type { RemoteWebPairingRequestSummary } from "@vellumai/service-contracts/remote-web-pairing";

import { t } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import {
  ALREADY_APPROVED_ERROR_CODE,
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
 * local-gateway base URL; the caller gates mounting on its availability.
 *
 * A failed poll keeps the previous list (a transient loopback-proxy hiccup
 * shouldn't flash the UI empty) and records a non-fatal error instead. A
 * 404/410 from approve/deny means the request expired or was handled elsewhere
 * (the CLI `--web-approve` path can race the UI), so the row is removed as if
 * the action succeeded. A deny rejected with 409 ALREADY_APPROVED also removes
 * the row (it is no longer pending) but keeps a sticky notice up: the deny
 * never took effect and the device is now paired. Other action errors are
 * dropped once a successful poll no longer lists their request; with the row
 * gone there is nothing left to retry.
 *
 * A `base` change drops the previous gateway's rows and errors and aborts its
 * in-flight action, so stale requests are never shown against the new base.
 */
export function usePendingPairingRequests(
  base: string,
  onApproved?: () => void,
): PendingPairingRequestsController {
  const [requests, setRequests] = useState<RemoteWebPairingRequestSummary[]>(
    [],
  );
  const [actingOn, setActingOn] = useState<{
    requestId: string;
    action: PendingPairingAction;
  } | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  // Tagged with its request so a poll can drop it once the row disappears.
  const [actionError, setActionError] = useState<{
    requestId: string;
    message: string;
    /** Survives the row leaving the list (deny lost the race to an approve). */
    sticky?: boolean;
  } | null>(null);

  const pollAbortRef = useRef<AbortController | null>(null);
  const actionAbortRef = useRef<AbortController | null>(null);

  // Requests and errors belong to the gateway they came from. When `base`
  // changes, drop them during render so the old assistant's rows can never be
  // shown against (or acted on toward) the new one.
  const [lastBase, setLastBase] = useState(base);
  if (base !== lastBase) {
    setLastBase(base);
    setRequests([]);
    setActingOn(null);
    setPollError(null);
    setActionError(null);
  }

  // Abort any in-flight approve/deny on base change and unmount, and release
  // the single-action guard so the new base's actions aren't blocked.
  useEffect(() => {
    return () => {
      actionAbortRef.current?.abort();
      actionAbortRef.current = null;
    };
  }, [base]);

  useEffect(() => {
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
        // An action error whose request left the list is unactionable; drop it
        // so it can't pin an empty section open forever. Sticky notices stay:
        // the user must still learn a deny never took effect.
        setActionError((prev) =>
          prev &&
          !prev.sticky &&
          !next.some((r) => r.requestId === prev.requestId)
            ? null
            : prev,
        );
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
        setPollError(t("settings:usePendingPairingRequests.pollErrorFallback"));
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
      if (actionAbortRef.current) {
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
        if (controller.signal.aborted) {
          // Aborted by a base change; the row no longer belongs to this list.
          return;
        }
        removeRequest();
        if (action === "approve") {
          // A device just paired; let siblings (the device list) revalidate.
          onApproved?.();
        }
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (err instanceof PairDeviceError) {
          if (
            action === "deny" &&
            err.status === 409 &&
            err.code === ALREADY_APPROVED_ERROR_CODE
          ) {
            // The deny lost a race to an approve on another surface: the row
            // is no longer pending, but the deny did NOT take effect, and the
            // user must learn a device they tried to reject is now paired.
            removeRequest();
            // The device is paired despite the deny; siblings should see it.
            onApproved?.();
            setActionError({
              requestId,
              message: t(
                "settings:usePendingPairingRequests.denyAlreadyApproved",
              ),
              sticky: true,
            });
          } else if (err.status === 404 || err.status === 410) {
            // Expired or already handled elsewhere; treat as removed.
            removeRequest();
          } else {
            setActionError({ requestId, message: err.message });
          }
        } else {
          captureError(err, { context: "pair-device-pending-request-action" });
          setActionError({
            requestId,
            message: t("settings:usePendingPairingRequests.actionErrorFallback"),
          });
        }
      } finally {
        // Only release the guard if it's still ours; a base change may have
        // cleared it and a new base's action may already hold it.
        if (actionAbortRef.current === controller) {
          actionAbortRef.current = null;
        }
        if (!controller.signal.aborted) {
          setActingOn(null);
        }
      }
    },
    [base, onApproved],
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
    error: actionError?.message ?? pollError,
    approve,
    deny,
  };
}

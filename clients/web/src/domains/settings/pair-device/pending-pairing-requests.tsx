import { useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { Loader2 } from "lucide-react";

import { currentLocale, useTranslation } from "@/i18n";
import { formatRelativeTime } from "@/lib/relative-time";

import { usePendingPairingRequests } from "./use-pending-pairing-requests";

interface PendingPairingRequestsProps {
  /** Absolute local-gateway base URL the requests are listed and acted on against. */
  base: string;
  /** Fired when an action pairs a device, so siblings can revalidate. */
  onApproved?: () => void;
}

/** How often visible relative ages re-render; 30s suits minute phrasing. */
const AGE_REFRESH_INTERVAL_MS = 30_000;

/**
 * Relative label for a request's timestamp in the active i18n locale.
 * Pending requests are short-lived, so minute granularity is enough;
 * anything under a minute reads as "now".
 */
function formatRequestedAt(iso: string): string {
  return formatRelativeTime(new Date(iso).getTime(), {
    locale: currentLocale(),
    minimumUnit: "minute",
  });
}

/**
 * The approval half of the Pair Device card: pending pairing requests minted
 * elsewhere (the public `/assistant/pair` page), each approvable or deniable
 * by the host. Renders nothing while no request is pending and the list poll
 * is healthy. Each row shows its user code prominently so the approver can
 * match it against the requesting device's screen: the device-flow
 * anti-phishing binding.
 */
export function PendingPairingRequests({
  base,
  onApproved,
}: PendingPairingRequestsProps) {
  const { t } = useTranslation("settings");
  const { requests, actingOn, error, approve, deny } =
    usePendingPairingRequests(base, onApproved);

  // The hook keeps a stable list reference while the pending set is unchanged,
  // so nothing re-renders on its own and relative ages would freeze. Tick a
  // render while any request is visible so `formatRequestedAt` stays current.
  const hasRequests = requests.length > 0;
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    if (!hasRequests) {
      return;
    }
    const intervalId = setInterval(
      () => setAgeTick((tick) => tick + 1),
      AGE_REFRESH_INTERVAL_MS,
    );
    return () => clearInterval(intervalId);
  }, [hasRequests]);

  // An empty list with no error is the quiet normal state; a poll error must
  // still surface so an outage isn't mistaken for an empty queue.
  if (requests.length === 0 && !error) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3 border-t border-[var(--border-element)] pt-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-title-small text-[var(--content-emphasised)]">
          {t("pendingPairingRequests.title")}
        </h3>
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          {t("pendingPairingRequests.instruction")}
        </p>
      </div>
      {error && <Notice tone="error" title={error} />}
      {requests.length > 0 && (
        <ul className="flex flex-col gap-2">
          {requests.map((request) => {
            const rowAction =
              actingOn !== null && actingOn.requestId === request.requestId
                ? actingOn.action
                : null;
            const approving = rowAction === "approve";
            const denying = rowAction === "deny";
            return (
              <li
                key={request.requestId}
                className="flex flex-col gap-2 rounded-lg border border-[var(--border-element)] p-3"
              >
                <code className="w-fit rounded-md bg-[var(--surface-active)] px-2.5 py-1.5 text-title-medium tracking-wide text-[var(--content-emphasised)]">
                  {request.userCode}
                </code>
                <div className="flex flex-col gap-0.5">
                  <p className="text-body-small-default text-[var(--content-tertiary)]">
                    {request.viaEdgeProxy === false
                      ? // Host-originated mint: the requester IP is a loopback
                        // address, so naming this computer is the honest label.
                        t("pendingPairingRequests.requestedMetaHost", {
                          when: formatRequestedAt(request.requestedAt),
                        })
                      : t("pendingPairingRequests.requestedMeta", {
                          when: formatRequestedAt(request.requestedAt),
                          ip: request.requesterIp,
                        })}
                  </p>
                  {request.requesterUserAgent && (
                    <p
                      className="truncate text-body-small-default text-[var(--content-tertiary)]"
                      title={request.requesterUserAgent}
                    >
                      {request.requesterUserAgent}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="compact"
                    disabled={actingOn !== null}
                    aria-busy={approving || undefined}
                    leftIcon={
                      approving ? <Loader2 className="animate-spin" /> : undefined
                    }
                    onClick={() => void approve(request.requestId)}
                  >
                    {t("pendingPairingRequests.approveButton")}
                  </Button>
                  <Button
                    variant="dangerOutline"
                    size="compact"
                    disabled={actingOn !== null}
                    aria-busy={denying || undefined}
                    leftIcon={
                      denying ? <Loader2 className="animate-spin" /> : undefined
                    }
                    onClick={() => void deny(request.requestId)}
                  >
                    {t("pendingPairingRequests.denyButton")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

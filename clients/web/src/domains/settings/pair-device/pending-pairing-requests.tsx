import { useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

import { currentLocale, useTranslation } from "@/i18n";

import { usePendingPairingRequests } from "./use-pending-pairing-requests";

interface PendingPairingRequestsProps {
  /** Absolute local-gateway base URL the requests are listed and acted on against. */
  base: string;
}

/** How often visible relative ages re-render; 30s suits minute phrasing. */
const AGE_REFRESH_INTERVAL_MS = 30_000;

const RELATIVE_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> =
  [
    { unit: "day", ms: 86_400_000 },
    { unit: "hour", ms: 3_600_000 },
    { unit: "minute", ms: 60_000 },
  ];

/**
 * Relative label for a request's timestamp in the active i18n locale.
 * Pending requests are short-lived, so minutes/hours/days cover the range;
 * anything under a minute reads as "now".
 */
function formatRequestedAt(iso: string): string {
  const formatter = new Intl.RelativeTimeFormat(currentLocale(), {
    numeric: "auto",
  });
  const diffMs = new Date(iso).getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  for (const { unit, ms } of RELATIVE_UNITS) {
    if (absMs >= ms) {
      return formatter.format(Math.trunc(diffMs / ms), unit);
    }
  }
  return formatter.format(0, "second");
}

/**
 * The approval half of the Pair Device card: pending pairing requests minted
 * elsewhere (the public `/assistant/pair` page), each approvable or deniable
 * by the host. Renders nothing while no request is pending and the list poll
 * is healthy. Each row shows its user code prominently so the approver can
 * match it against the requesting device's screen: the device-flow
 * anti-phishing binding.
 */
export function PendingPairingRequests({ base }: PendingPairingRequestsProps) {
  const { t } = useTranslation("settings");
  const { requests, actingOn, error, approve, deny } =
    usePendingPairingRequests(base);

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
          {requests.map((request) => (
            <li
              key={request.requestId}
              className="flex flex-col gap-2 rounded-lg border border-[var(--border-element)] p-3"
            >
              <code className="w-fit rounded-md bg-[var(--surface-active)] px-2.5 py-1.5 text-title-medium tracking-wide text-[var(--content-emphasised)]">
                {request.userCode}
              </code>
              <div className="flex flex-col gap-0.5">
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  {t("pendingPairingRequests.requestedMeta", {
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
                  onClick={() => void approve(request.requestId)}
                >
                  {t("pendingPairingRequests.approveButton")}
                </Button>
                <Button
                  variant="dangerOutline"
                  size="compact"
                  disabled={actingOn !== null}
                  onClick={() => void deny(request.requestId)}
                >
                  {t("pendingPairingRequests.denyButton")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

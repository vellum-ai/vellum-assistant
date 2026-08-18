import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

import { useTranslation } from "@/i18n";
import { formatRelativeDate } from "@/utils/format-date";

import { usePendingPairingRequests } from "./use-pending-pairing-requests";

interface PendingPairingRequestsProps {
  /** Absolute local-gateway base URL the requests are listed and acted on against. */
  base: string;
}

/**
 * The approval half of the Pair Device card: pending pairing requests minted
 * elsewhere (the public `/assistant/pair` page), each approvable or deniable
 * by the host. Renders nothing while no request is pending. Each row shows its
 * user code prominently so the approver can match it against the requesting
 * device's screen: the device-flow anti-phishing binding.
 */
export function PendingPairingRequests({ base }: PendingPairingRequestsProps) {
  const { t } = useTranslation("settings");
  const { requests, actingOn, error, approve, deny } =
    usePendingPairingRequests(base);

  if (requests.length === 0) {
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
                  when: formatRelativeDate(request.requestedAt),
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
    </section>
  );
}

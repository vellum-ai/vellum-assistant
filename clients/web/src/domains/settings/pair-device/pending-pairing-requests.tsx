import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { cn } from "@vellumai/design-library/utils/cn";
import { Loader2 } from "lucide-react";

import { useTranslation } from "@/i18n";

import { CODE_CHIP_CLASS } from "./code-chip";
import { formatRelativeAge, useRelativeAgeTick } from "./relative-age";
import { usePendingPairingRequests } from "./use-pending-pairing-requests";

interface PendingPairingRequestsProps {
  /** Absolute local-gateway base URL the requests are listed and acted on against. */
  base: string;
  /** Fired when an action pairs a device, so siblings can revalidate. */
  onApproved?: () => void;
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
  // so nothing here re-renders on its own and the ages below would freeze.
  useRelativeAgeTick(requests.length > 0);

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
                <code
                  className={cn(
                    CODE_CHIP_CLASS,
                    "w-fit px-2.5 py-1.5 text-title-medium tracking-wide text-[color:var(--content-emphasised)]",
                  )}
                >
                  {request.userCode}
                </code>
                <div className="flex flex-col gap-0.5">
                  <p className="text-body-small-default text-[var(--content-tertiary)]">
                    {request.viaEdgeProxy === false
                      ? // Host-originated mint: the requester IP is a loopback
                        // address, so naming this computer is the honest label.
                        t("pendingPairingRequests.requestedMetaHost", {
                          when: formatRelativeAge(request.requestedAt),
                        })
                      : t("pendingPairingRequests.requestedMeta", {
                          when: formatRelativeAge(request.requestedAt),
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

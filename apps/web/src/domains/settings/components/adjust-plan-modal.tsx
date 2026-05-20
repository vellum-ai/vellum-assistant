import { CircleCheck, Crown, Loader2, Palmtree } from "lucide-react";
import { useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Modal } from "@vellum/design-library/components/modal";
import { Notice } from "@vellum/design-library/components/notice";
import { Tag } from "@vellum/design-library/components/tag";
import { toast } from "@vellum/design-library/components/toast";
import { Typography } from "@vellum/design-library/components/typography";
import { DowngradeReconfirmModal } from "@/domains/settings/components/downgrade-reconfirm-modal.js";
import {
  organizationsBillingPlansRetrieveOptions,
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
  organizationsBillingSubscriptionUpgradeCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen.js";
import {
  buildPortalReturnSnapshot,
  formatGraceDate,
  getEffectiveCancelDate,
  useBillingPortalSession,
} from "@/domains/settings/hooks/use-billing-portal-session.js";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser.js";
import { WWW_DOMAIN } from "@/lib/domains.js";

const DOCS_URL = `https://${WWW_DOMAIN}/docs`;

/**
 * Extract a user-facing message from a subscription mutation error.
 *
 * DRF field errors arrive as `{ field_name: [message, ...] }`; we probe the
 * known fields and fall back to `detail` then a caller-provided generic.
 */
const DRF_FIELD_KEYS = [
  "target_plan_id",
  "confirm",
  "machine_tier",
  "storage_tier",
  "non_field_errors",
] as const;

function extractMutationError(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    for (const key of DRF_FIELD_KEYS) {
      const msgs = rec[key];
      if (Array.isArray(msgs) && typeof msgs[0] === "string") {
        return msgs[0];
      }
    }
    if (typeof rec.detail === "string") {
      return rec.detail;
    }
  }
  return fallback;
}

export interface AdjustPlanModalProps {
  open: boolean;
  onClose: () => void;
}

export function AdjustPlanModal({ open, onClose }: AdjustPlanModalProps) {
  const queryClient = useQueryClient();
  const plansQuery = useQuery(organizationsBillingPlansRetrieveOptions());
  const subscriptionQuery = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );
  const upgradeMutation = useMutation(
    organizationsBillingSubscriptionUpgradeCreateMutation(),
  );
  const portalSnapshot = buildPortalReturnSnapshot(subscriptionQuery.data);
  const portalMutation = useBillingPortalSession(portalSnapshot);
  const [downgradeOpen, setDowngradeOpen] = useState(false);

  // On native (Capacitor iOS), Stripe Checkout / the billing portal opens in
  // SFSafariViewController as a popover on top of the app. When the user
  // finishes (or cancels), `browserFinished` fires while we're still mounted
  // with stale subscription data. Invalidate the relevant queries so the
  // surrounding UI re-fetches, then close the modal.
  useEffect(() => {
    return openUrlFinishedListener(() => {
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingPlansRetrieveQueryKey(),
      });
      onClose();
    });
  }, [queryClient, onClose]);

  const currentPlanId = subscriptionQuery.data?.plan_id;
  const cancelAtPeriodEnd =
    subscriptionQuery.data?.cancel_at_period_end === true ||
    Boolean(subscriptionQuery.data?.cancel_at);
  const isCanceled = subscriptionQuery.data?.status === "canceled";
  const cancelDate = getEffectiveCancelDate(subscriptionQuery.data);

  const handleUpgrade = () => {
    if (upgradeMutation.isPending) return;
    // ATL-532 will replace these hardcoded defaults with a tier-picker UI.
    upgradeMutation.mutate(
      {
        body: {
          target_plan_id: "pro",
          confirm: true,
          machine_tier: "medium",
          storage_tier: "xs",
        },
      },
      {
        onSuccess: (data) => {
          if (data.checkout_url) {
            void openUrl(data.checkout_url);
            return;
          }
          if (data.status === "no_op") {
            toast.info("You're already on Pro.", { id: "pro-upgrade" });
            onClose();
            return;
          }
          toast.error(
            data.message ?? "Failed to start upgrade. Please try again.",
            { id: "pro-upgrade-error" },
          );
        },
        onError: (error) => {
          toast.error(
            extractMutationError(
              error,
              "Failed to start upgrade. Please try again.",
            ),
            { id: "pro-upgrade-error" },
          );
        },
      },
    );
  };

  const handleConfirmDowngrade = () => {
    if (portalMutation.isPending) return;
    setDowngradeOpen(false);
    portalMutation.mutate({});
  };

  const isLoading = plansQuery.isLoading || subscriptionQuery.isLoading;
  const isError =
    plansQuery.isError ||
    subscriptionQuery.isError ||
    !plansQuery.data ||
    !subscriptionQuery.data;

  return (
    <>
      <Modal.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <Modal.Content size="lg">
          <Modal.Header>
            <Modal.Title>Upgrade Plan</Modal.Title>
            <Modal.Description className="sr-only">
              Compare plans and choose the one that matches your usage.
            </Modal.Description>
          </Modal.Header>
          <Modal.Body>
            {isLoading ? (
              <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                <Typography as="span" variant="body-medium-lighter">
                  Loading plans...
                </Typography>
              </div>
            ) : isError ? (
              <Notice tone="error">
                Failed to load plans. Please try again later.
              </Notice>
            ) : (
              <div className="space-y-6">
                <div className="space-y-2 text-center">
                  <Typography as="p" variant="title-medium">
                    More Power, Better Productivity.
                  </Typography>
                  <Typography
                    as="p"
                    variant="body-medium-lighter"
                    className="text-[var(--content-secondary)]"
                  >
                    Our plans are designed to give you the best based on what
                    you need.
                  </Typography>
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {plansQuery.data!.plans.map((plan) => {
                    const isCurrent = plan.id === currentPlanId;
                    const isProCard = plan.id === "pro";
                    const isBaseCard = plan.id === "base";
                    const onPro = currentPlanId === "pro";
                    const showCancellationOnPro =
                      isProCard && onPro && cancelAtPeriodEnd && !isCanceled;
                    return (
                      <Card
                        key={plan.id}
                        padding="lg"
                        className="bg-[var(--surface-base)]"
                      >
                        <div className="flex flex-col gap-4">
                          <span
                            aria-hidden
                            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)]"
                          >
                            {isProCard ? (
                              <Crown className="h-5 w-5 text-[var(--content-default)]" />
                            ) : (
                              <Palmtree className="h-5 w-5 text-[var(--content-default)]" />
                            )}
                          </span>
                          <div className="flex items-center gap-2">
                            <Typography as="h3" variant="title-small">
                              {plan.name}
                            </Typography>
                            {isCurrent && <Tag tone="positive">Current</Tag>}
                          </div>
                          {showCancellationOnPro && cancelDate && (
                            <Typography
                              as="p"
                              variant="body-small-default"
                              className="text-[var(--system-mid-strong)]"
                              data-testid="modal-cancels-on"
                            >
                              Your plan ends on {formatGraceDate(cancelDate)}
                            </Typography>
                          )}
                          <hr className="border-t border-[var(--border-base)]" />
                          <div className="flex flex-col gap-1">
                            {isBaseCard ? (
                              <>
                                <Typography as="p" variant="title-medium">
                                  Free
                                </Typography>
                                <Typography
                                  as="p"
                                  variant="body-small-default"
                                  className="text-[var(--content-tertiary)]"
                                >
                                  Forever
                                </Typography>
                              </>
                            ) : (
                              <>
                                <Typography as="p" variant="title-medium">
                                  From $
                                  {Math.round(
                                    (plan.base_price_cents +
                                      Math.min(
                                        ...plan.machine_tiers.map(
                                          (t) => t.price_cents,
                                        ),
                                      ) +
                                      Math.min(
                                        ...plan.storage_tiers.map(
                                          (t) => t.price_cents,
                                        ),
                                      )) /
                                      100,
                                  )}
                                </Typography>
                                <Typography
                                  as="p"
                                  variant="body-small-default"
                                  className="text-[var(--content-tertiary)]"
                                >
                                  Billed monthly
                                </Typography>
                              </>
                            )}
                          </div>
                          {!isCurrent && isProCard && (
                            <Button
                              variant="primary"
                              className="w-full"
                              onClick={handleUpgrade}
                              disabled={upgradeMutation.isPending}
                              data-testid="modal-upgrade-to-pro-button"
                            >
                              Get to PRO Plan
                            </Button>
                          )}
                          {!isCurrent &&
                            isBaseCard &&
                            onPro &&
                            !cancelAtPeriodEnd && (
                              <Button
                                variant="outlined"
                                className="w-full"
                                onClick={() => setDowngradeOpen(true)}
                                disabled={portalMutation.isPending}
                                data-testid="modal-downgrade-to-base-button"
                              >
                                Downgrade to Base
                              </Button>
                            )}
                          {showCancellationOnPro && (
                            <Button
                              variant="outlined"
                              className="w-full"
                              onClick={() => portalMutation.mutate({})}
                              disabled={portalMutation.isPending}
                              data-testid="modal-keep-plan-button"
                            >
                              Keep your Plan
                            </Button>
                          )}
                          <hr className="border-t border-[var(--border-base)]" />
                          <div className="flex flex-col gap-3">
                            <Typography
                              as="p"
                              variant="body-small-default"
                              className="text-[var(--content-secondary)]"
                            >
                              {isBaseCard
                                ? "Plan includes:"
                                : "Plan includes everything in free and:"}
                            </Typography>
                            <ul className="flex flex-col gap-2">
                              {plan.included_features.map((feature) => (
                                <li
                                  key={feature}
                                  className="flex items-start gap-2"
                                >
                                  <CircleCheck
                                    className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
                                    aria-hidden
                                  />
                                  <Typography
                                    as="span"
                                    variant="body-medium-default"
                                  >
                                    {feature}
                                  </Typography>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}
          </Modal.Body>
          <Modal.Footer className="items-center">
            <Typography
              as="p"
              variant="body-small-default"
              className="flex-1 text-center text-[var(--content-tertiary)]"
            >
              You can cancel or change your plan anytime you want. To learn
              more{" "}
              <a
                href={DOCS_URL}
                className="underline"
                target="_blank"
                rel="noreferrer"
              >
                Read our Docs.
              </a>
            </Typography>
            <Button
              variant="outlined"
              onClick={onClose}
              data-testid="modal-cancel-button"
            >
              Cancel
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
      <DowngradeReconfirmModal
        open={downgradeOpen}
        onCancel={() => setDowngradeOpen(false)}
        onConfirm={handleConfirmDowngrade}
        confirming={portalMutation.isPending}
      />
    </>
  );
}

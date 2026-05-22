import { Crown, Loader2, Palmtree } from "lucide-react";
import { useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Modal } from "@vellum/design-library/components/modal";
import { Notice } from "@vellum/design-library/components/notice";
import { Tag } from "@vellum/design-library/components/tag";
import { toast } from "@vellum/design-library/components/toast";
import { Typography } from "@vellum/design-library/components/typography";
import { DowngradeReconfirmModal } from "./downgrade-reconfirm-modal.js";
import { PlanFeatureList } from "./plan-feature-list.js";
import { TierPicker, isTierDisabled } from "./tier-picker.js";
import type {
  MachineTier,
  MachineTierEnum,
  ProPlan,
  StorageTier,
  StorageTierEnum,
} from "@/generated/api/types.gen.js";
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
import { WWW_DOMAIN } from "@/utils/domains.js";

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

/**
 * Resolve which tier should be selected given the user's previous choice and
 * the current tier list. Keeps `prev` only if it is still present AND enabled;
 * otherwise falls back to the first enabled tier (or null when none qualify).
 *
 * Revalidating against the live list guards the case where a plans refetch
 * removes or disables the previously-selected tier while the modal is open —
 * the CTA's non-null gate alone would otherwise let the user submit a stale or
 * now-disabled tier that the server rejects.
 */
export function resolveTierSelection<T extends string>(
  tiers: (MachineTier | StorageTier)[],
  prev: T | null,
): T | null {
  const enabled = tiers.filter((t) => !isTierDisabled(t));
  if (prev !== null && enabled.some((t) => t.tier === prev)) {
    return prev;
  }
  return (enabled[0]?.tier ?? null) as T | null;
}

/**
 * Cheapest tier price in cents, or 0 when the list is empty. Guards the
 * "From $" summary against `Math.min(...[])` → `Infinity` (which would render
 * "From $Infinity"). Production plans always carry populated tier arrays, so
 * this only matters defensively.
 */
function minTierPriceCents(tiers: (MachineTier | StorageTier)[]): number {
  return tiers.length ? Math.min(...tiers.map((t) => t.price_cents)) : 0;
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
  const [selectedMachineTier, setSelectedMachineTier] =
    useState<MachineTierEnum | null>(null);
  const [selectedStorageTier, setSelectedStorageTier] =
    useState<StorageTierEnum | null>(null);

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

  const proPlan = plansQuery.data?.plans.find(
    (p): p is ProPlan => p.id === "pro",
  );

  // Default-to-cheapest: when the modal opens and plans land, seed each
  // selection to the first *enabled* tier, preserving any still-valid choice
  // the user already made. `resolveTierSelection` also revalidates the prior
  // choice against the current list, so a refetch that disables or removes the
  // selected tier re-seeds rather than leaving a stale value the CTA's non-null
  // gate would submit. Reset to null on close; stays null when none qualify.
  useEffect(() => {
    if (!open) {
      setSelectedMachineTier(null);
      setSelectedStorageTier(null);
      return;
    }
    if (!proPlan) return;
    setSelectedMachineTier((prev) =>
      resolveTierSelection<MachineTierEnum>(proPlan.machine_tiers, prev),
    );
    setSelectedStorageTier((prev) =>
      resolveTierSelection<StorageTierEnum>(proPlan.storage_tiers, prev),
    );
  }, [open, proPlan]);

  const basePlan = plansQuery.data?.plans.find((p) => p.id === "base");
  const baseFeatureSet = new Set(basePlan?.included_features ?? []);
  const lostFeatures = (proPlan?.included_features ?? []).filter(
    (f) => !baseFeatureSet.has(f),
  );

  const currentPlanId = subscriptionQuery.data?.plan_id;
  const cancelAtPeriodEnd =
    subscriptionQuery.data?.cancel_at_period_end === true ||
    Boolean(subscriptionQuery.data?.cancel_at);
  const isCanceled = subscriptionQuery.data?.status === "canceled";
  const cancelDate = getEffectiveCancelDate(subscriptionQuery.data);

  const handleUpgrade = () => {
    if (upgradeMutation.isPending) return;
    if (!selectedMachineTier || !selectedStorageTier) {
      toast.error("Pick a machine and storage tier to continue.", {
        id: "pro-upgrade-error",
      });
      return;
    }
    upgradeMutation.mutate(
      {
        body: {
          target_plan_id: "pro",
          confirm: true,
          machine_tier: selectedMachineTier,
          storage_tier: selectedStorageTier,
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
            <Modal.Title className="sr-only">Upgrade Plan</Modal.Title>
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
                <div className="space-y-2 pb-2 pt-4 text-center">
                  <Typography as="p" variant="title-medium">
                    Your Assistant, Your Way
                  </Typography>
                  <Typography
                    as="p"
                    variant="body-medium-lighter"
                    className="text-[var(--content-secondary)]"
                  >
                    Choose the plan that works best for you and your assistant.
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
                        className="flex flex-col bg-[var(--surface-base)]"
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
                          <div className="flex min-h-6 items-center gap-2">
                            <Typography as="h3" variant="title-small">
                              {plan.name}
                            </Typography>
                            {isCurrent && <Tag tone="positive">Current</Tag>}
                          </div>
                          <Typography
                            as="p"
                            variant="body-small-default"
                            className="-mt-2 text-[var(--content-tertiary)]"
                          >
                            {isBaseCard
                              ? "All you need for a capable assistant"
                              : "More features, more compute, more storage"}
                          </Typography>
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
                                      minTierPriceCents(plan.machine_tiers) +
                                      minTierPriceCents(plan.storage_tiers)) /
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
                          <PlanFeatureList
                            features={plan.included_features}
                            variant="checklist"
                          />
                        </div>
                        <div className="mt-4 flex flex-1 flex-col justify-end gap-4">
                          {!isCurrent && isProCard && (
                            <>
                              <hr className="border-t border-[var(--border-base)]" />
                              <TierPicker
                                machineTiers={plan.machine_tiers}
                                storageTiers={plan.storage_tiers}
                                basePriceCents={plan.base_price_cents}
                                selectedMachineTier={selectedMachineTier}
                                selectedStorageTier={selectedStorageTier}
                                onMachineTierChange={setSelectedMachineTier}
                                onStorageTierChange={setSelectedStorageTier}
                              />
                              <Button
                                variant="primary"
                                className="w-full"
                                onClick={handleUpgrade}
                                disabled={
                                  upgradeMutation.isPending ||
                                  !selectedMachineTier ||
                                  !selectedStorageTier
                                }
                                data-testid="modal-upgrade-to-pro-button"
                              >
                                Upgrade to Pro
                              </Button>
                            </>
                          )}
                          {!isCurrent &&
                            isBaseCard &&
                            onPro &&
                            !cancelAtPeriodEnd && (
                              <>
                                <hr className="border-t border-[var(--border-base)]" />
                                <Button
                                  variant="outlined"
                                  className="w-full"
                                  onClick={() => setDowngradeOpen(true)}
                                  disabled={portalMutation.isPending}
                                  data-testid="modal-downgrade-to-base-button"
                                >
                                  Downgrade to Base
                                </Button>
                              </>
                            )}
                          {showCancellationOnPro && (
                            <>
                              <hr className="border-t border-[var(--border-base)]" />
                              <Button
                                variant="outlined"
                                className="w-full"
                                onClick={() => portalMutation.mutate({})}
                                disabled={portalMutation.isPending}
                                data-testid="modal-keep-plan-button"
                              >
                                Keep your Plan
                              </Button>
                            </>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}
          </Modal.Body>
          <Modal.Footer className="relative items-center">
            <Typography
              as="p"
              variant="body-small-default"
              className="pointer-events-none absolute inset-x-0 text-center text-[var(--content-tertiary)]"
            >
              <span className="pointer-events-auto">
                You can change or cancel your plan at any time.{" "}
                <a
                  href={`${DOCS_URL}/pricing`}
                  className="underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Read our docs
                </a>{" "}
                for details.
              </span>
            </Typography>
            <div className="ml-auto">
              <Button
                variant="outlined"
                onClick={onClose}
                data-testid="modal-cancel-button"
              >
                Cancel
              </Button>
            </div>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
      <DowngradeReconfirmModal
        open={downgradeOpen}
        onCancel={() => setDowngradeOpen(false)}
        onConfirm={handleConfirmDowngrade}
        confirming={portalMutation.isPending}
        lostFeatures={lostFeatures}
      />
    </>
  );
}

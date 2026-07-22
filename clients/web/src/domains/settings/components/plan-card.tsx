import { Coins, Computer, HardDrive, Loader2, Rocket, Sparkles } from "lucide-react";

import { useState } from "react";

import { useNavigate } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    nextPackageUp,
    type ProPackage,
} from "@/domains/settings/billing/package-types";
import {
    FREE_STORAGE_GIB,
    PlanTierAvatar,
    TIER_ACCENT,
} from "@/domains/settings/billing/plan-tier-meta";
import {
    formatGraceDate,
    getEffectiveCancelDate,
} from "@/domains/settings/hooks/use-billing-portal-session";
import {
    organizationsBillingPlansRetrieveOptions,
    organizationsBillingPlansRetrieveQueryKey,
    organizationsBillingSubscriptionRetrieveOptions,
    organizationsBillingSubscriptionRetrieveQueryKey,
    organizationsBillingSubscriptionUpgradeCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { MachineSizeEnum, ProPlan } from "@/generated/api/types.gen";
import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
import { checkoutReturnTarget } from "@/lib/billing/checkout-return-target";
import { SIZE_LABEL } from "@/lib/billing/machine-sizes";
import { openUrl } from "@/runtime/browser";
import { routes } from "@/utils/routes";
import type { ButtonProps } from "@vellumai/design-library/components/button";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";
import { extractMutationError } from "./adjust-plan-utils";
import { formatMonthly } from "./tier-pricing";

interface PlanDisplay {
    actionLabel: string;
    actionVariant: ButtonProps["variant"];
    actionTestId: string;
    showsRenewal: boolean;
}

const PLAN_DISPLAY: Record<string, PlanDisplay> = {
    pro: {
        actionLabel: "Manage",
        actionVariant: "outlined",
        actionTestId: "plan-card-manage-button",
        showsRenewal: true,
    },
    base: {
        actionLabel: "View Plans",
        actionVariant: "primary",
        actionTestId: "plan-card-upgrade-button",
        showsRenewal: true,
    },
};

const DEFAULT_DISPLAY: PlanDisplay = PLAN_DISPLAY.base;

export interface PlanCardProps {
    onManage: () => void;
}

function PlanHeading() {
    return (
        <Typography
            as="h2"
            variant="title-medium"
            className="text-[var(--content-emphasised)]"
        >
            Plan
        </Typography>
    );
}

/**
 * The "standard" machine a package with no `machine_size` runs on — the small
 * baseline that Free and machine-less Pro packages (e.g. Mighty) share.
 */
const STANDARD_MACHINE_LABEL = "Small";

/** Machine size label for a package (or the standard small machine). */
function machineLabel(pkg: ProPackage | null): string {
    if (!pkg?.machine_size) {
        return STANDARD_MACHINE_LABEL;
    }
    const size = pkg.machine_size as MachineSizeEnum;
    return SIZE_LABEL[size] ?? pkg.machine_size;
}

interface ResourceDelta {
    icon: typeof Computer;
    label: string;
}

/** "X → Y" only when the resource actually changes; the bare value otherwise. */
function arrow(from: string, to: string): string {
    return from === to ? to : `${from} → ${to}`;
}

/**
 * The (max three) chips shown on the recommended-upgrade card. Credits and
 * storage change at every step of the catalog, so they anchor the first two
 * slots. The third slot shows the machine `from → to` when the tier steps up;
 * on the Free → Pro step the machine stays on the small baseline, but Pro
 * unlocks the `LARGER_MACHINE` entitlement, so it advertises that scale-up
 * headroom instead of a no-op "Small Machine" chip. A step that changes neither
 * (not in the current catalog) simply shows the two anchor chips.
 */
function buildDeltas(
    recommended: ProPackage,
    currentPackage: ProPackage | null,
): ResourceDelta[] {
    const fromCredits = currentPackage?.credits_usd ?? 0;
    const toCredits = recommended.credits_usd ?? 0;
    const fromStorage = currentPackage?.storage_gib ?? FREE_STORAGE_GIB;

    const deltas: ResourceDelta[] = [
        {
            icon: Coins,
            label: `${arrow(`$${fromCredits}`, `$${toCredits}`)} credits/mo`,
        },
        {
            icon: HardDrive,
            label: `${arrow(String(fromStorage), String(recommended.storage_gib))} GB`,
        },
    ];

    const fromMachine = machineLabel(currentPackage);
    const toMachine = machineLabel(recommended);
    if (fromMachine !== toMachine) {
        deltas.push({
            icon: Computer,
            label: `${fromMachine} → ${toMachine} Machine`,
        });
    } else if (currentPackage === null) {
        // Free → Pro keeps the small baseline machine, but Pro unlocks the
        // ability to scale to larger machines — surface that capability rather
        // than a static "Small Machine" chip that reads as no upgrade.
        deltas.push({ icon: Rocket, label: "Larger machines" });
    }

    return deltas;
}

interface RecommendedUpgradeProps {
    packages: ProPackage[];
    currentKey: string | null;
    /**
     * Delegate for subscribers who are already on Pro — the upgrade endpoint
     * no-ops for active Pro orgs, so package step-ups go through the manage
     * flow instead. When absent (base plan), the CTA starts the Stripe
     * package checkout directly.
     */
    onUpgrade?: () => void;
}

function RecommendedUpgrade({
    packages,
    currentKey,
    onUpgrade,
}: RecommendedUpgradeProps) {
    const queryClient = useQueryClient();
    const upgradeMutation = useMutation(
        organizationsBillingSubscriptionUpgradeCreateMutation(),
    );
    const [pending, setPending] = useState(false);

    const recommended = nextPackageUp(packages, currentKey);
    if (!recommended) return null;

    const currentPackage = currentKey
        ? (packages.find((p) => p.key === currentKey) ?? null)
        : null;
    const currentPriceCents = currentPackage?.total_price_cents ?? 0;
    const deltas = buildDeltas(recommended, currentPackage);
    const priceLabel = `${formatMonthly(recommended.total_price_cents).replace("/mo", "")} / Monthly`;
    const deltaCents = recommended.total_price_cents - currentPriceCents;
    const upgradeLabel = `Upgrade for ${formatMonthly(deltaCents)} more`;
    const accent = TIER_ACCENT[recommended.key] ?? TIER_ACCENT.free;
    const tint = `color-mix(in srgb, ${accent} 10%, transparent)`;
    const isPending = pending || upgradeMutation.isPending;

    const handleUpgrade = async () => {
        if (onUpgrade) {
            onUpgrade();
            return;
        }
        setPending(true);
        try {
            // A package checkout resolves its own line items server-side;
            // explicit tiers / include_platform_fee alongside `package` are
            // rejected by the upgrade serializer.
            const result = await upgradeMutation.mutateAsync({
                body: {
                    target_plan_id: "pro",
                    package: recommended.key,
                    confirm: true,
                    return_target: checkoutReturnTarget(),
                },
            });
            if (result.status === "redirect" && result.checkout_url) {
                // Stash the purchased package so the provisioning screen can
                // show it before the subscribe webhook lands — and so it can't
                // read a stale intent left by an abandoned earlier checkout.
                saveCheckoutIntent({
                    kind: "package",
                    packageKey: recommended.key,
                });
                // Stripe returns with a `session_id`, which opens the
                // post-checkout Pro onboarding wizard — via the billing page on
                // web, via the `billing/checkout-complete` deep link on macOS.
                openUrl(result.checkout_url);
            } else {
                await queryClient.invalidateQueries({
                    queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
                });
                await queryClient.invalidateQueries({
                    queryKey: organizationsBillingPlansRetrieveQueryKey(),
                });
            }
        } catch (error) {
            toast.error(
                extractMutationError(
                    error,
                    "Failed to start the upgrade checkout. Please try again.",
                ),
            );
        } finally {
            setPending(false);
        }
    };

    return (
        <div
            className="flex flex-col gap-6 rounded-lg p-3"
            style={{ backgroundColor: tint }}
        >
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <PlanTierAvatar tier={recommended.key} />
                    <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <Typography
                                as="span"
                                variant="body-large-default"
                                className="text-[var(--content-default)]"
                            >
                                {recommended.name}
                            </Typography>
                            <Tag
                                className="bg-[var(--feed-digest-weak)] text-[var(--credits-accent)]"
                                leftIcon={
                                    <Sparkles className="h-3 w-3 text-[var(--credits-accent)]" />
                                }
                            >
                                Recommended Upgrade
                            </Tag>
                        </div>
                        <Typography
                            as="span"
                            variant="body-small-default"
                            className="text-[var(--content-tertiary)]"
                        >
                            {priceLabel}
                        </Typography>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {deltas.map((delta) => {
                        const Icon = delta.icon;
                        return (
                            <div
                                key={delta.label}
                                className="flex h-8 items-center gap-1.5 rounded-lg px-2 py-1.5"
                                style={{ backgroundColor: tint }}
                            >
                                <Icon
                                    className="h-3.5 w-3.5 shrink-0 text-[var(--content-default)]"
                                    aria-hidden
                                />
                                <Typography
                                    as="span"
                                    variant="body-medium-default"
                                    className="whitespace-nowrap text-[var(--content-default)]"
                                >
                                    {delta.label}
                                </Typography>
                            </div>
                        );
                    })}
                </div>
            </div>
            <Button
                variant="primary"
                className="self-start"
                onClick={handleUpgrade}
                disabled={isPending}
                leftIcon={
                    isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : undefined
                }
                data-testid="recommended-upgrade-button"
            >
                {upgradeLabel}
            </Button>
        </div>
    );
}

export function PlanCard({ onManage }: PlanCardProps) {
    const navigate = useNavigate();
    const subscriptionQuery = useQuery(
        organizationsBillingSubscriptionRetrieveOptions(),
    );
    const plansQuery = useQuery(organizationsBillingPlansRetrieveOptions());

    if (subscriptionQuery.isLoading || plansQuery.isLoading) {
        return (
            <Card padding="md">
                <PlanHeading />
                <div className="mt-4 flex items-center gap-2 text-[var(--content-tertiary)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <Typography as="span" variant="body-small-default">
                        Loading plan...
                    </Typography>
                </div>
            </Card>
        );
    }

    const subscription = subscriptionQuery.data;
    const plans = plansQuery.data?.plans;
    const currentPlan = plans?.find((p) => p.id === subscription?.plan_id);

    if (
        subscriptionQuery.isError ||
        plansQuery.isError ||
        !subscription ||
        !plans ||
        !currentPlan
    ) {
        return <Notice tone="error">Failed to load plan.</Notice>;
    }

    const display = PLAN_DISPLAY[currentPlan.id] ?? DEFAULT_DISPLAY;
    // Prefer the pinned package name (e.g. "Mighty") over the generic plan name
    // ("Pro"). A plan whose tiers have diverged from the pinned package is
    // flagged custom so it doesn't masquerade as the stock package.
    const planName = subscription.package
        ? `${subscription.package.name}${subscription.package.customized ? " (Custom)" : ""}`
        : (currentPlan.name ?? currentPlan.id);

    const isCancelling =
        display.showsRenewal &&
        (subscription.cancel_at_period_end === true ||
            Boolean(subscription.cancel_at));
    const isCanceled = subscription.status === "canceled";
    const cancelDate = getEffectiveCancelDate(subscription);
    const showRenewal =
        display.showsRenewal &&
        !isCancelling &&
        !isCanceled &&
        subscription.current_period_end;
    const showCancellation =
        display.showsRenewal && isCancelling && !isCanceled && cancelDate;

    const proPlan = plans.find((p): p is ProPlan => p.id === "pro");
    // Empty while the `pro-packages` flag is off — the upgrade banner no-ops.
    const packages = proPlan?.packages ?? [];
    const currentKey = subscription.package?.key ?? null;
    const currentTier = currentKey ?? "free";

    return (
        <Card padding="md">
            <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                    <PlanHeading />
                    <Button
                        variant={display.actionVariant}
                        onClick={
                            // Base plan with a live catalog opens the full-screen
                            // plans takeover; Pro "Manage" (and the flag-off empty
                            // catalog) keep the modal.
                            currentPlan.id === "base" && packages.length > 0
                                ? () => navigate(routes.plans)
                                : onManage
                        }
                        data-testid={display.actionTestId}
                        className="shrink-0"
                    >
                        {display.actionLabel}
                    </Button>
                </div>
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3 rounded-lg bg-[var(--surface-base)] py-1.5 pl-3 pr-2">
                        <div className="flex min-w-0 items-center gap-3">
                            <PlanTierAvatar tier={currentTier} />
                            <div className="flex min-w-0 flex-col gap-1">
                                <Typography
                                    variant="body-large-default"
                                    as="div"
                                    className="text-[var(--content-default)]"
                                    data-testid="plan-card-name"
                                >
                                    {planName}
                                </Typography>
                                {showRenewal && (
                                    <Typography
                                        variant="body-small-default"
                                        as="div"
                                        className="leading-snug text-[var(--content-tertiary)]"
                                        data-testid="plan-card-renews"
                                    >
                                        Monthly Payment &bull; Your subscription
                                        will auto renew on{" "}
                                        {formatGraceDate(
                                            subscription.current_period_end!,
                                        )}
                                        .
                                    </Typography>
                                )}
                                {showCancellation && (
                                    <Typography
                                        variant="body-small-default"
                                        as="div"
                                        className="leading-snug text-[var(--system-mid-strong)]"
                                        data-testid="plan-card-cancels"
                                    >
                                        Your plan ends on{" "}
                                        {formatGraceDate(cancelDate!)}.
                                    </Typography>
                                )}
                            </div>
                        </div>
                    </div>
                    <RecommendedUpgrade
                        packages={packages}
                        currentKey={currentKey}
                        onUpgrade={
                            currentPlan.id === "base" ? undefined : onManage
                        }
                    />
                </div>
            </div>
        </Card>
    );
}

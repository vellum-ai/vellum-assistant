import {
    Computer,
    Crown,
    HardDrive,
    Loader2,
    Microchip,
    Palmtree,
    Sparkles,
    type LucideIcon,
} from "lucide-react";

import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    nextPackageUp,
    PACKAGE_PRESETS,
    type ProPackage,
} from "@/domains/settings/billing/package-types";
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
import type {
    MachineSizeEnum,
    ProPlan,
    SubscriptionUpgradeRequestRequest,
} from "@/generated/api/types.gen";
import { SIZE_DESCRIPTION, SIZE_LABEL } from "@/lib/billing/machine-sizes";
import { openUrl } from "@/runtime/browser";
import type { ButtonProps } from "@vellumai/design-library/components/button";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";
import { formatMonthly } from "./tier-pricing";

interface PlanDisplay {
    icon: LucideIcon;
    actionLabel: string;
    actionVariant: ButtonProps["variant"];
    actionTestId: string;
    showsRenewal: boolean;
}

const PLAN_DISPLAY: Record<string, PlanDisplay> = {
    pro: {
        icon: Crown,
        actionLabel: "Manage",
        actionVariant: "outlined",
        actionTestId: "plan-card-manage-button",
        showsRenewal: true,
    },
    base: {
        icon: Palmtree,
        actionLabel: "Upgrade",
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
        <div>
            <Typography
                as="h2"
                variant="title-medium"
                className="text-[var(--content-default)]"
            >
                Plan
            </Typography>
            <Typography
                as="p"
                variant="body-small-default"
                className="mt-2 text-[var(--content-tertiary)]"
            >
                Manage which Vellum plan you&apos;re on.
            </Typography>
        </div>
    );
}

/** Parse a cpu_limit string like "2000m" into a display label like "2 vCPU's". */
function cpuLimitToLabel(cpuLimit: string | null | undefined): string {
    if (!cpuLimit) return "Standard";
    const match = cpuLimit.match(/^(\d+)m$/);
    if (match) {
        const millicores = parseInt(match[1], 10);
        const vcpus = millicores / 1000;
        return `${vcpus % 1 === 0 ? vcpus : vcpus.toFixed(1)} vCPU${vcpus === 1 ? "" : "'s"}`;
    }
    return cpuLimit;
}

/** Derive a human-readable machine size label from a ProPackage. */
function packageMachineLabel(pkg: ProPackage): {
    sizeLabel: string;
    vcpuLabel: string;
} {
    if (pkg.machine_size) {
        const size = pkg.machine_size as MachineSizeEnum;
        const desc = SIZE_DESCRIPTION[size] ?? pkg.machine_size;
        const vcpuMatch = desc.match(/(\d+\.?\d*)\s*vCPU/);
        return {
            sizeLabel: SIZE_LABEL[size] ?? pkg.machine_size,
            vcpuLabel: vcpuMatch
                ? `${vcpuMatch[1]} vCPU${vcpuMatch[1] === "1" ? "" : "'s"}`
                : desc,
        };
    }
    return {
        sizeLabel: "Standard",
        vcpuLabel: cpuLimitToLabel(null),
    };
}

interface ResourceDelta {
    icon: typeof Computer;
    label: string;
}

function buildDeltas(pkg: ProPackage, currentPlanId: string): ResourceDelta[] {
    const { sizeLabel, vcpuLabel } = packageMachineLabel(pkg);

    if (currentPlanId === "base") {
        return [
            { icon: Computer, label: `Small → ${sizeLabel} Machine` },
            { icon: Microchip, label: `2 → ${vcpuLabel.replace(/ vCPU.?s?$/, " vCPU's")}` },
            { icon: HardDrive, label: `0 → ${pkg.storage_gib} GB` },
        ];
    }

    return [
        { icon: Computer, label: `${sizeLabel} Machine` },
        { icon: Microchip, label: vcpuLabel },
        { icon: HardDrive, label: `${pkg.storage_gib} GB` },
    ];
}

interface RecommendedUpgradeProps {
    packages: ProPackage[];
    currentPlanId: string;
    currentKey: string | null;
    onUpgrade?: () => void;
}

function RecommendedUpgrade({
    packages,
    currentPlanId,
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
        ? packages.find((p) => p.key === currentKey)
        : null;
    const currentPriceCents = currentPackage?.total_price_cents ?? 0;
    const deltas = buildDeltas(recommended, currentPlanId);
    const priceLabel = `${formatMonthly(recommended.total_price_cents).replace("/mo", "")} / Monthly`;
    const deltaCents = recommended.total_price_cents - currentPriceCents;
    const upgradeLabel = `Upgrade for ${formatMonthly(deltaCents)} more`;

    const handleUpgrade = async () => {
        if (onUpgrade) {
            onUpgrade();
            return;
        }
        setPending(true);
        try {
            const body: SubscriptionUpgradeRequestRequest = {
                target_plan_id: "pro",
                storage_tier: recommended.storage_tier as SubscriptionUpgradeRequestRequest["storage_tier"],
                machine_tier: (recommended.machine_tier ?? null) as SubscriptionUpgradeRequestRequest["machine_tier"],
                credit_tier: (recommended.credit_tier ?? null) as SubscriptionUpgradeRequestRequest["credit_tier"],
                include_platform_fee: recommended.include_platform_fee,
                confirm: false,
            };
            // PR #9200 adds a `package` param to the upgrade request. The
            // generated type doesn't include it yet, so we attach it via a
            // local cast. When #9200 merges and types regenerate, remove cast.
            const bodyWithPackage = {
                ...body,
                package: recommended.key,
            } as unknown as SubscriptionUpgradeRequestRequest;

            const result = await upgradeMutation.mutateAsync(
                bodyWithPackage as never,
            );
            if (result.status === "redirect" && result.checkout_url) {
                openUrl(result.checkout_url);
            } else {
                await queryClient.invalidateQueries({
                    queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
                });
                await queryClient.invalidateQueries({
                    queryKey: organizationsBillingPlansRetrieveQueryKey(),
                });
            }
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="flex flex-col gap-4 rounded-xl bg-[var(--system-positive-weak)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span
                            aria-hidden
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-lift)]"
                        >
                            <Sparkles className="h-4 w-4 text-[var(--system-positive-strong)]" />
                        </span>
                        <Typography as="h3" variant="title-small" className="text-[var(--content-default)]">
                            {recommended.name}
                        </Typography>
                        <Tag tone="positive" leftIcon={<Sparkles />}>
                            Recommended Upgrade
                        </Tag>
                    </div>
                    <Typography as="p" variant="title-medium" className="text-[var(--content-default)]">
                        {priceLabel}
                    </Typography>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {deltas.map((delta) => {
                        const Icon = delta.icon;
                        return (
                            <div
                                key={delta.label}
                                className="flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[var(--surface-lift)] px-2.5 py-1.5"
                            >
                                <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]" aria-hidden />
                                <Typography as="span" variant="body-small-default" className="text-[var(--content-secondary)]">
                                    {delta.label}
                                </Typography>
                            </div>
                        );
                    })}
                </div>
            </div>

            <Button
                variant="primary"
                fullWidth
                onClick={handleUpgrade}
                disabled={pending || upgradeMutation.isPending}
                leftIcon={
                    pending || upgradeMutation.isPending ? (
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
    const PlanIcon = display.icon;
    const planName = currentPlan.name ?? currentPlan.id;

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

    const proPlan = plans.find((p) => p.id === "pro");
    const apiPackages = readPackages(proPlan);
    const packages = apiPackages.length > 0 ? apiPackages : PACKAGE_PRESETS;
    const currentKey =
        (subscription as unknown as { package_key?: string | null })
            .package_key ?? null;

    return (
        <Card padding="lg">
            <div className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                    <PlanHeading />
                    <Button
                        variant={display.actionVariant}
                        onClick={onManage}
                        data-testid={display.actionTestId}
                    >
                        {display.actionLabel}
                    </Button>
                </div>
                <div className="flex items-center gap-3 rounded-lg bg-[var(--surface-base)] p-3">
                    <span
                        aria-hidden
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)]"
                    >
                        <PlanIcon className="h-4 w-4 text-[var(--content-default)]" />
                    </span>
                    <div className="min-w-0 flex-1 space-y-0.5">
                        <Typography variant="body-medium-default" as="div" data-testid="plan-card-name">
                            {planName}
                        </Typography>
                        {showRenewal && (
                            <Typography
                                variant="body-small-default"
                                as="div"
                                className="leading-snug text-[var(--content-tertiary)]"
                                data-testid="plan-card-renews"
                            >
                                Monthly Payment &bull; Your subscription will auto renew on {formatGraceDate(subscription.current_period_end!)}.
                            </Typography>
                        )}
                        {showCancellation && (
                            <Typography
                                variant="body-small-default"
                                as="div"
                                className="leading-snug text-[var(--system-mid-strong)]"
                                data-testid="plan-card-cancels"
                            >
                                Your plan ends on {formatGraceDate(cancelDate!)}.
                            </Typography>
                        )}
                    </div>
                </div>
                <RecommendedUpgrade
                    packages={packages}
                    currentPlanId={currentPlan.id}
                    currentKey={currentKey}
                    onUpgrade={onManage}
                />
            </div>
        </Card>
    );
}

/**
 * Read packages defensively from a Pro plan entry. The `packages` field is
 * additive (platform PR #9200, gated behind the `pro-packages` LaunchDarkly
 * flag). The generated type doesn't include it yet, so we read via a local
 * cast. When #9200 merges and types regenerate, this cast can be removed.
 */
export function readPackages(plan: ProPlan | undefined): ProPackage[] {
    return (plan as unknown as { packages?: ProPackage[] })?.packages ?? [];
}

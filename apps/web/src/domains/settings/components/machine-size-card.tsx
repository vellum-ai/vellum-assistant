import { Loader2 } from "lucide-react";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Notice } from "@vellum/design-library/components/notice";
import { Typography } from "@vellum/design-library/components/typography";
import {
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";

/**
 * MachineSizeCard — surfaces the Pro machine tier ceiling on billing
 * settings.
 *
 * Renders a flat Card (no SkillRow) with a heading, a sentence describing
 * the org's max machine tier (Medium / Large / Extra Large), and a
 * Configure CTA that fans out to the parent via `onManage`. Returns
 * `null` for Base users.
 */

const TIER_LABEL: Record<string, string> = {
  medium: "Medium",
  large: "Large",
  xl: "Extra Large",
};

export interface MachineSizeCardProps {
  onManage: () => void;
}

function MachineHeading() {
  return (
    <div>
      <Typography
        as="h2"
        variant="title-medium"
        className="text-[var(--content-default)]"
      >
        Machine Size
      </Typography>
      <Typography
        as="p"
        variant="body-small-default"
        className="mt-2 text-[var(--content-tertiary)]"
      >
        The machine size your assistants run at.
      </Typography>
    </div>
  );
}

function MachineErrorCard() {
  return (
    <Card padding="md">
      <MachineHeading />
      <Notice tone="error">Failed to load machine configuration.</Notice>
    </Card>
  );
}

export function MachineSizeCard({ onManage }: MachineSizeCardProps) {
  const subscriptionQuery = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );
  const isPro = subscriptionQuery.data?.plan_id === "pro";
  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: isPro,
  });

  // Gate the onboarding spinner on `isPro` so Base users never spin on a
  // query they won't fire. TanStack v5 `isLoading = isPending && isFetching`,
  // so a disabled query already reports `isLoading=false`; the explicit gate
  // documents intent and guards against a future switch to `isPending`.
  if (
    subscriptionQuery.isLoading ||
    (isPro && onboardingQuery.isLoading)
  ) {
    return (
      <Card padding="md">
        <MachineHeading />
        <div className="mt-4 flex items-center gap-2 text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <Typography as="span" variant="body-small-default">
            Loading machine configuration...
          </Typography>
        </div>
      </Card>
    );
  }

  // Subscription error must surface BEFORE the isPro gate — when the
  // subscription fetch fails, `data` is undefined and `isPro` is false, so a
  // Pro user with a transient subscription failure would otherwise see an
  // empty slot instead of an error.
  if (subscriptionQuery.isError) return <MachineErrorCard />;
  if (!isPro) return null;
  if (onboardingQuery.isError) return <MachineErrorCard />;

  const maxTier = onboardingQuery.data?.max_machine_tier ?? null;
  const tierLabel = maxTier ? TIER_LABEL[maxTier] ?? maxTier : null;

  return (
    <Card padding="md">
      <div className="flex flex-col gap-4">
        <MachineHeading />
        {tierLabel ? (
          <Typography
            as="p"
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
            data-testid="machine-size-tier-label"
          >
            Your Pro tier allows assistants up to{" "}
            <span className="text-[var(--content-default)]">{tierLabel}</span>{" "}
            size.
          </Typography>
        ) : (
          <Notice tone="warning">
            Your subscription does not have a machine tier configured.
          </Notice>
        )}
        <div>
          <Button
            variant="outlined"
            onClick={onManage}
            disabled={!maxTier}
            data-testid="machine-size-configure-button"
          >
            Configure Machine Size
          </Button>
        </div>
      </div>
    </Card>
  );
}

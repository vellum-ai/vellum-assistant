/**
 * **Every wall a user can hit, and the CTA we show them, on one page.**
 *
 * This is the index for the rest of the `Upsell Walls/` section: each case
 * below states what triggers the wall, what the button says, and where it goes,
 * above the real component rendering it. Individual story files drill into the
 * per-wall variants (dismissible/not, pending, error). Native Android renders
 * every wall exactly as iOS does; only the purchase CTAs behave differently
 * there, handing off to the web app's billing page in the browser
 * (`lib/billing/android-billing-handoff.ts`).
 *
 * It lives outside `src/domains/` deliberately: the walls span chat, settings
 * and billing, and `local/no-cross-domain-imports` only constrains files that
 * sit inside a domain.
 *
 * Two things worth knowing before reading it:
 *
 *   - **Add credits vs Upgrade is one branch, not a redesign.** Every credit
 *     wall says "Add credits" unless the org is on the free (`base`) plan.
 *     Paid orgs keep "Add credits".
 *   - **Every non-credit upsell in the app routes to `routes.plans`**, the
 *     plans takeover. There is no second upsell destination.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CalendarClock, KeyRound, Sparkles } from "lucide-react";

import type { DiskPressureStatus } from "@vellumai/assistant-api";
import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { DiskPressureBanner } from "@/components/disk-pressure-banner";
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import {
  ADD_CREDITS_COPY,
  UPGRADE_COPY,
} from "@/domains/chat/components/credits-upsell-card";
import { EmailManagedContent } from "@/domains/channels/components/email-managed-content";
import { packageSpecs } from "@/domains/settings/billing/plan-spec";
import { PlanTile } from "@/domains/settings/billing/plan-tile";
import {
  makeProPackage,
  makeSuperPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import { formatDollars } from "@/domains/settings/components/tier-pricing";
import { organizationsBillingSubscriptionRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionResponse } from "@/generated/api/types.gen";

/**
 * The entitlement wall is the real `EmailManagedContent`, not a rebuild of it,
 * so the catalog cannot drift from the icon, copy and CTA wiring
 * the production component owns. Only the subscription read is faked; one
 * instance mounts here, and the component writes no global store, so unlike the
 * credit wall it is safe to co-mount with the rest of the page.
 */
const NOT_ENTITLED: SubscriptionResponse = {
  plan_id: "base",
  status: "active",
  renewal_date: null,
  current_period_start: null,
  current_period_end: null,
  cancel_at_period_end: false,
  cancel_at: null,
  entitlements: { managed_email: false, phone_number: false },
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
queryClient.setQueryData(
  organizationsBillingSubscriptionRetrieveOptions().queryKey,
  NOT_ENTITLED,
);

const DISK_STATUS: DiskPressureStatus = {
  enabled: true,
  state: "warning",
  locked: false,
  acknowledged: false,
  overrideActive: false,
  effectivelyLocked: false,
  lockId: null,
  usagePercent: 86,
  thresholdPercent: 85,
  path: "/workspace",
  lastCheckedAt: "2026-08-04T12:00:00Z",
  blockedCapabilities: [],
  error: null,
};

/**
 * The plan tile's CTA quotes the real price delta between the current package
 * and the next one up, so the story derives it from the same fixtures the
 * billing suites use rather than hardcoding a number that can drift.
 */
const SUPER_PACKAGE = makeSuperPackage();
const POWER_UP_LABEL = `Power Up for +${formatDollars(
  SUPER_PACKAGE.total_price_cents - makeProPackage().total_price_cents,
)}/month`;

interface WallCaseProps {
  wall: string;
  trigger: string;
  cta: string;
  destination: string;
  children: React.ReactNode;
}

/** Story chrome: the metadata row above each live wall. */
function WallCase({
  wall,
  trigger,
  cta,
  destination,
  children,
}: WallCaseProps) {
  return (
    <section className="flex flex-col gap-2">
      <h3
        className="text-body-medium-default m-0"
        style={{ color: "var(--content-default)" }}
      >
        {wall}
      </h3>
      <dl
        className="text-label-small-default m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"
        style={{ color: "var(--content-tertiary)" }}
      >
        <dt>Triggered when</dt>
        <dd className="m-0">{trigger}</dd>
        <dt>CTA</dt>
        <dd className="m-0" style={{ color: "var(--content-default)" }}>
          {cta}
        </dd>
        <dt>Goes to</dt>
        <dd className="m-0">{destination}</dd>
      </dl>
      <div className="mt-1">{children}</div>
    </section>
  );
}

function Group({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6">
      <h2
        className="text-body-large-default m-0 border-b pb-2"
        style={{
          color: "var(--content-default)",
          borderColor: "var(--border-default)",
        }}
      >
        {heading}
      </h2>
      {children}
    </section>
  );
}

const meta: Meta = {
  title: "Upsell Walls/Overview",
  parameters: { layout: "padded", controls: { disable: true } },
};

export default meta;
type Story = StoryObj;

/** Credit walls: the only place the CTA label forks. */
export const CreditWalls: Story = {
  render: () => (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-10 py-4">
      <Group heading="Credit walls">
        <WallCase
          wall="Out of credits (default)"
          trigger="Balance ≤ 0 on any paid plan (an unresolved plan counts as paid)."
          cta={ADD_CREDITS_COPY.ctaLabel}
          destination="Add Credits modal → Stripe checkout"
        >
          <BillingErrorBanner
            ariaLabel={`${ADD_CREDITS_COPY.title}. ${ADD_CREDITS_COPY.subtitle}`}
            icon={<span className="text-lg opacity-80">💰</span>}
            title={ADD_CREDITS_COPY.title}
            subtitle={ADD_CREDITS_COPY.subtitle}
            action={{ label: ADD_CREDITS_COPY.ctaLabel, onClick: () => {} }}
            detached
          />
        </WallCase>

        <WallCase
          wall="Out of credits (free plan)"
          trigger="Balance ≤ 0 AND plan_id = base."
          cta={UPGRADE_COPY.ctaLabel}
          destination="/assistant/plans (plans takeover)"
        >
          <BillingErrorBanner
            ariaLabel={`${UPGRADE_COPY.title}. ${UPGRADE_COPY.subtitle}`}
            icon={<span className="text-lg opacity-80">💰</span>}
            title={UPGRADE_COPY.title}
            subtitle={UPGRADE_COPY.subtitle}
            action={{ label: UPGRADE_COPY.ctaLabel, onClick: () => {} }}
            detached
          />
        </WallCase>

        <WallCase
          wall="Low balance"
          trigger="Server sets low_balance_warning, balance still > 0, banner not dismissed."
          cta="Add credits"
          destination="Add Credits modal → Stripe checkout"
        >
          <BillingErrorBanner
            ariaLabel="Your credits are running low. Add credits to avoid an interruption."
            title="Your credits are running low"
            subtitle="Add credits to avoid an interruption."
            action={{ label: "Add credits", onClick: () => {} }}
            onDismiss={() => {}}
          />
        </WallCase>

        <WallCase
          wall="Daily credit limit reached"
          trigger="User's own daily spend cap hit. Not a plan wall."
          cta="Adjust Limit"
          destination="/assistant/settings/usage?tab=billing"
        >
          <BillingErrorBanner
            ariaLabel="Daily credit limit reached"
            icon={
              <CalendarClock
                className="size-5"
                style={{ color: "var(--content-tertiary)" }}
              />
            }
            title="Daily credit limit reached"
            subtitle="This limit applies to Vellum credit spend and resets at midnight UTC."
            action={{ label: "Adjust Limit", onClick: () => {} }}
          />
        </WallCase>

        <WallCase
          wall="Provider billing (bring-your-own key)"
          trigger="The user's own model provider is out of funds."
          cta="Open Settings"
          destination="/assistant/settings/ai (no Vellum upsell)"
        >
          <BillingErrorBanner
            ariaLabel="Your API key needs credits"
            icon={
              <KeyRound
                className="size-5"
                style={{ color: "var(--content-tertiary)" }}
              />
            }
            title="Your API key needs credits"
            subtitle="Add funds with your provider or lower the model token limit."
            action={{ label: "Open Settings", onClick: () => {} }}
          />
        </WallCase>
      </Group>
    </div>
  ),
};

/** Storage, entitlement and plan walls, all of which route to the takeover. */
export const ResourceAndEntitlementWalls: Story = {
  render: () => (
    // The seeded client is only for the entitlement wall's subscription read;
    // every other case on this page is pure props.
    <QueryClientProvider client={queryClient}>
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-10 py-4">
        <Group heading="Storage wall">
          <WallCase
            wall="Storage almost full"
            trigger="Disk usage crosses the warn threshold on a platform-hosted assistant."
            cta="Manage Storage + Upgrade"
            destination="/workspace?sort=size · /assistant/plans"
          >
            <DiskPressureBanner
              status={DISK_STATUS}
              mode="warning"
              onAcknowledge={() => {}}
              onDismissWarning={() => {}}
              onReviewWorkspaceData={() => {}}
              onUpgradeStorage={() => {}}
            />
          </WallCase>

          <WallCase
            wall="Storage almost full (no upgrade path)"
            trigger="Same, but self-hosted. The Upgrade CTA is dropped and the copy stops offering more storage."
            cta="Manage Storage"
            destination="/workspace?sort=size"
          >
            <DiskPressureBanner
              status={DISK_STATUS}
              mode="warning"
              onAcknowledge={() => {}}
              onDismissWarning={() => {}}
              onReviewWorkspaceData={() => {}}
              onUpgradeStorage={null}
            />
          </WallCase>

          <WallCase
            wall="Storage critically low"
            trigger="Disk usage crosses the critical threshold; the assistant will lock if it runs out."
            cta="Review (the Upgrade CTA lives in the modal it opens)"
            destination="/assistant/plans"
          >
            <DiskPressureBanner
              status={{ ...DISK_STATUS, state: "critical", usagePercent: 99 }}
              mode="acknowledgement-required"
              onAcknowledge={() => {}}
              onUpgradeStorage={() => {}}
            />
          </WallCase>
        </Group>

        <Group heading="Entitlement wall">
          <WallCase
            wall="Managed email not included"
            trigger="entitlements.managed_email is false on the subscription. Read off the entitlement, not the plan. An admin override can grant it to a Base org."
            cta="Upgrade"
            destination="/assistant/plans"
          >
            <EmailManagedContent
              assistantId="story-assistant"
              assistantHandle="ada"
              emailRootDomain="vellum.ai"
            />
          </WallCase>
        </Group>

        <Group heading="Plan management upsell">
          <WallCase
            wall="Next plan tile"
            trigger="A higher package exists in the catalog and the relation is not a lateral switch. A Pro user at the top of the catalog, or one whose tiers match no package, gets no tile at all; the plans takeover keeps the customize path."
            cta={POWER_UP_LABEL}
            destination="Stripe checkout (base) or package-switch confirm (pro)"
          >
            <div className="w-[360px]">
              <PlanTile
                theme="dark"
                tierKey={SUPER_PACKAGE.key}
                name={SUPER_PACKAGE.name}
                tag={
                  <Tag
                    className="bg-[var(--feed-digest-weak)] text-[var(--credits-accent)]"
                    leftIcon={
                      <Sparkles
                        className="text-[var(--credits-accent)]"
                        aria-hidden
                      />
                    }
                  >
                    Next Plan
                  </Tag>
                }
                specs={packageSpecs(SUPER_PACKAGE, {
                  usageIncludedLabel: "Super Usage included",
                })}
                footer={
                  <Button
                    variant="primary"
                    fullWidth
                    tintColor="var(--aux-white)"
                    className="h-10 border-transparent bg-[var(--system-positive-strong)] hover:bg-[var(--system-positive-strong)] hover:opacity-90 active:bg-[var(--system-positive-strong)]"
                    onClick={() => {}}
                  >
                    {POWER_UP_LABEL}
                  </Button>
                }
              />
            </div>
          </WallCase>
        </Group>

      </div>
    </QueryClientProvider>
  ),
};

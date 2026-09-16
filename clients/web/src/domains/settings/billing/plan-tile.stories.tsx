/**
 * The billing "Plan" section renders two of these tiles side by side: the
 * current plan (inheriting the app theme, with a price footer) and the
 * recommended next plan (a nested inverted theme scope, with the green upgrade
 * CTA). `plan-card.tsx` owns both call sites; the tag, price row, and CTA are
 * slots it passes in, so the stories below reproduce those nodes exactly.
 *
 * `theme` on the next tile is not a fixed value in the app: `plan-card.tsx`
 * inverts the *resolved* app theme, so a light app gets a dark tile and a dark
 * or velvet app gets a light one. The single-tile stories pin `theme="dark"` to
 * document the prop; `SideBySide` reproduces the inversion.
 *
 * Specs come from the production `packageSpecs()` / `freePlanSpecs()` builders
 * fed by the shared package fixtures, so the chips read as they do in the app.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Loader2, Sparkles } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  freePlanSpecs,
  packageSpecs,
} from "@/domains/settings/billing/plan-spec";
import { PlanTile } from "@/domains/settings/billing/plan-tile";
import {
  frameWidthDecorator,
  PLAN_TILE_WIDTH_PX,
  STORY_PERIOD_END,
} from "@/domains/settings/billing/billing-story-frame";
import {
  UsageBalancePanel,
  type UsagePeriodEnd,
  usagePeriodEndLabels,
} from "@/domains/settings/billing/usage-balance-panel";
import {
  makeProPackage,
  makeSuperPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import {
  formatDollars,
  priceLabelFromCents,
} from "@/domains/settings/components/tier-pricing";
import { useDocumentTheme } from "@/hooks/use-document-theme";
import { useTranslation } from "@/i18n";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

// Every story here draws a creature avatar, so warm the bundled-component
// chunk at module scope the way `plans-page.tsx` does; otherwise each tile
// holds a blank placeholder for the first frame.
preloadBundledAvatarComponents();

const MIGHTY = makeProPackage();
const SUPER = makeSuperPackage();

/** Two tiles plus the row's `gap-4`. */
const ROW_WIDTH_PX = PLAN_TILE_WIDTH_PX * 2 + 16;

/** The upgrade CTA quotes the price difference, as `plan-card.tsx` composes it. */
const UPGRADE_LABEL = `Power Up for +${formatDollars(
  SUPER.total_price_cents - MIGHTY.total_price_cents,
)}/month`;

/** The current-plan tile's tag. */
const CURRENT_TAG = <Tag tone="info">Current</Tag>;

/** The next-plan tile's tag: sparkles and the credits accent. */
const NEXT_PLAN_TAG = (
  <Tag
    className="bg-[var(--feed-digest-weak)] text-[var(--credits-accent)]"
    leftIcon={<Sparkles className="text-[var(--credits-accent)]" aria-hidden />}
  >
    Next Plan
  </Tag>
);

/**
 * The current-plan tile's footer when there is no usage reading to chart, as
 * `plan-card.tsx` lays it out: a rule, the monthly price where the catalog
 * has one, and the cycle-end line for a sub that has one, worded by the
 * panel's own helper so the story reads exactly as the card does.
 */
function PriceFooter({
  label,
  periodEnd,
}: {
  label: string | null;
  periodEnd?: UsagePeriodEnd;
}) {
  const { t } = useTranslation("settings");
  const renewal = usagePeriodEndLabels(periodEnd, t);
  return (
    <div className="flex h-10 items-center justify-between gap-3 border-t border-[var(--border-base)]">
      {label ? (
        <Typography
          as="span"
          variant="body-large-default"
          className="text-[var(--content-tertiary)]"
        >
          {label}
        </Typography>
      ) : null}
      {renewal ? (
        <Typography
          as="span"
          variant="body-small-default"
          className="whitespace-nowrap text-[var(--content-tertiary)]"
        >
          {renewal.line}
        </Typography>
      ) : null}
    </div>
  );
}

/** The next-plan tile's footer: the full-width green upgrade button. */
function upgradeCta(pending = false) {
  return (
    <Button
      variant="primary"
      fullWidth
      tintColor="var(--aux-white)"
      className="h-10 border-transparent bg-[var(--system-positive-strong)] hover:bg-[var(--system-positive-strong)] hover:opacity-90 active:bg-[var(--system-positive-strong)]"
      onClick={() => {}}
      disabled={pending}
      leftIcon={
        pending ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined
      }
    >
      {UPGRADE_LABEL}
    </Button>
  );
}

/** The row `plan-card.tsx` renders, which two stories mount at two widths. */
function PlanRow() {
  const inverted = useDocumentTheme() === "light" ? "dark" : "light";
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
      <PlanTile
        testId="plan-tile-current"
        tierKey={MIGHTY.key}
        name={MIGHTY.name}
        nameTestId="plan-card-name"
        tag={CURRENT_TAG}
        specs={packageSpecs(MIGHTY, `${MIGHTY.name} usage, reset monthly`)}
        footer={<UsageBalancePanel ratio={0.42} periodEnd={STORY_PERIOD_END} />}
      />
      <PlanTile
        theme={inverted}
        testId="plan-tile-next"
        tierKey={SUPER.key}
        name={SUPER.name}
        tag={NEXT_PLAN_TAG}
        specs={packageSpecs(SUPER, `${SUPER.name} usage, reset monthly`)}
        footer={upgradeCta()}
      />
    </div>
  );
}

const meta: Meta<typeof PlanTile> = {
  title: "Settings/Billing/PlanTile",
  component: PlanTile,
  parameters: { layout: "centered" },
  args: {
    tierKey: "free",
    name: "Free",
    tag: CURRENT_TAG,
  },
  decorators: [frameWidthDecorator],
};

export default meta;
type Story = StoryObj<typeof PlanTile>;

/**
 * A free user's current-plan tile: inherits the app theme (toggle the
 * Storybook theme to see both), pay-as-you-go chips, and a price row that
 * reads "Free Forever" because there is no subscription to price.
 */
export const CurrentFree: Story = {
  args: {
    testId: "plan-tile-current",
    tierKey: "free",
    name: "Free",
    nameTestId: "plan-card-name",
    tag: CURRENT_TAG,
    specs: freePlanSpecs(),
    footer: <PriceFooter label="Free Forever" />,
  },
};

/**
 * The same free tile with a usage grant to chart: the Current Usage bar takes
 * the footer over from "Free Forever", so the tile never states its allowance
 * twice. A free account that was never granted any usage has no bar, and
 * keeps the price row above. The grant is one-time, so the title carries no
 * date line.
 */
export const CurrentFreeUsageBalance: Story = {
  args: {
    ...CurrentFree.args,
    footer: <UsageBalancePanel ratio={0.68} />,
  },
};

/**
 * A subscriber's current-plan tile, on the catalog's Mighty package, when the
 * platform reports no grant figures to chart: with no Current Usage reading
 * the footer keeps the price row, dated with the renewal the subscription
 * itself carries. The price is the fixture's own
 * `total_price_cents` run through the shared `priceLabelFromCents` formatter,
 * so it stays honest if the package is repriced.
 */
export const CurrentPaid: Story = {
  args: {
    testId: "plan-tile-current",
    tierKey: MIGHTY.key,
    name: MIGHTY.name,
    nameTestId: "plan-card-name",
    tag: CURRENT_TAG,
    specs: packageSpecs(MIGHTY, `${MIGHTY.name} usage, reset monthly`),
    footer: (
      <PriceFooter
        label={priceLabelFromCents(MIGHTY.total_price_cents)}
        periodEnd={STORY_PERIOD_END}
      />
    ),
  },
};

/**
 * The paid tile with a usage reading. At a half-card tile this wide the usage
 * sentence drops to its own line below the machine and storage chips;
 * `SideBySideWide` shows the inline case. The price footer gives way to the
 * Current Usage bar, dated with the day the sub's bundle resets. Props
 * only, so the ratio here is a fixture rather than a live usage read.
 */
export const CurrentPaidUsageBalance: Story = {
  args: {
    ...CurrentPaid.args,
    footer: <UsageBalancePanel ratio={0.42} periodEnd={STORY_PERIOD_END} />,
  },
};

/**
 * The same tile at 260px, where every chip takes a line of its own and the
 * usage pill is free to wrap its label inside itself, the tile being narrower
 * than that label. Nothing overflows the tile.
 */
export const CurrentPaidNarrow: Story = {
  parameters: { frameWidth: 260 },
  args: CurrentPaidUsageBalance.args,
};

/**
 * The same tile once the bundle is spent and the wallet behind it is empty.
 * The footer panel turns its bar and reading negative and raises the
 * add-credits strip, which is the tallest the current tile ever gets: compare
 * it against `CurrentPaid` to see how much the footer grows.
 */
export const CurrentPaidExhausted: Story = {
  args: {
    ...CurrentPaid.args,
    footer: (
      <UsageBalancePanel
        ratio={1}
        periodEnd={STORY_PERIOD_END}
        exhausted
        onAddCredits={() => {}}
      />
    ),
  },
};

/**
 * A Custom subscriber, whose tier configuration matches no catalog package.
 * `"custom"` is not in the creature trait table, so `PlanTierAvatar` falls back
 * to the Free creature. There is no package to enumerate and no catalog price
 * to quote, so the tile carries no chips, and until its usage reading arrives
 * the footer holds only the cycle-end line. This fixture picked no credit
 * bundle, so that line names a renewal rather than a reset.
 */
export const CurrentCustom: Story = {
  args: {
    testId: "plan-tile-current",
    tierKey: "custom",
    name: "Custom",
    nameTestId: "plan-card-name",
    tag: CURRENT_TAG,
    specs: null,
    footer: (
      <PriceFooter
        label={null}
        periodEnd={{ ...STORY_PERIOD_END, kind: "renews" }}
      />
    ),
  },
};

/**
 * The recommended next plan. `theme="dark"` opens a nested theme scope, so the
 * tile stays dark whatever the app theme, and the CTA quotes the step up from
 * the current package.
 *
 * This story pins the prop to document it. The app does not: `plan-card.tsx`
 * (`RecommendedUpgrade`) owns the behavior and inverts the *resolved* app theme
 * via `useDocumentTheme()`, so a light app gets a dark tile and a dark or
 * velvet app gets a light one. `SideBySide` below reproduces that.
 */
export const NextPlan: Story = {
  args: {
    theme: "dark",
    testId: "plan-tile-next",
    tierKey: SUPER.key,
    name: SUPER.name,
    tag: NEXT_PLAN_TAG,
    specs: packageSpecs(SUPER, `${SUPER.name} usage, reset monthly`),
    footer: upgradeCta(),
  },
};

/**
 * The same tile with the package change in flight: a spinner joins the CTA and
 * the button is disabled, but the label keeps quoting the price so the tile
 * does not reflow mid-checkout.
 */
export const NextPlanPending: Story = {
  args: {
    ...NextPlan.args,
    footer: upgradeCta(true),
  },
};

/**
 * The real pairing, in the row `plan-card.tsx` renders: the current tile
 * inherits the app theme while the next-plan tile inverts it, exactly as
 * `RecommendedUpgrade` does. `useDocumentTheme()` reads the `data-theme`
 * attribute the themes addon stamps on the preview document, so toggling the
 * Storybook theme flips the next tile the way the app does. The row stacks
 * below the `lg` breakpoint: select `Mobile` in the viewport toolbar to see
 * that treatment, since the Canvas holds a desktop width regardless of window
 * size.
 */
export const SideBySide: Story = {
  parameters: {
    controls: { disable: true },
    frameWidth: ROW_WIDTH_PX,
  },
  render: PlanRow,
};

/**
 * The same row on a wide monitor, where each tile is around 940px and all
 * three chips sit inline. The 856px `SideBySide` above still wraps the usage
 * chip onto its own line, which is what the settings page gives two tiles at
 * desktop width.
 */
export const SideBySideWide: Story = {
  parameters: {
    controls: { disable: true },
    frameWidth: 1900,
  },
  render: PlanRow,
};

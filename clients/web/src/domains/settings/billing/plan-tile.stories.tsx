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
import { UsageBalancePanel } from "@/domains/settings/billing/usage-balance-panel";
import {
  makeProPackage,
  makeSuperPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import {
  formatDollars,
  priceLabelFromCents,
} from "@/domains/settings/components/tier-pricing";
import { useDocumentTheme } from "@/hooks/use-document-theme";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

// Every story here draws a creature avatar, so warm the bundled-component
// chunk at module scope the way `plans-page.tsx` does; otherwise each tile
// holds a blank placeholder for the first frame.
preloadBundledAvatarComponents();

const MIGHTY = makeProPackage();
const SUPER = makeSuperPackage();

/** The width the settings row gives a single tile (roughly half a card). */
const TILE_WIDTH_PX = 420;
/** Two tiles plus the row's `gap-2`. */
const ROW_WIDTH_PX = TILE_WIDTH_PX * 2 + 8;

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

/** The current-plan tile's footer: a rule and the monthly price. */
function priceFooter(label: string) {
  return (
    <div className="flex h-10 items-center border-t border-[var(--border-base)]">
      <Typography
        as="span"
        variant="body-large-default"
        className="text-[var(--content-tertiary)]"
      >
        {label}
      </Typography>
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

const meta: Meta<typeof PlanTile> = {
  title: "Settings/Billing/PlanTile",
  component: PlanTile,
  parameters: {
    layout: "centered",
    // Read by the decorator below; the pair story widens it for two tiles.
    frameWidth: TILE_WIDTH_PX,
  },
  args: {
    tierKey: "free",
    name: "Free",
    tag: CURRENT_TAG,
  },
  decorators: [
    (Story, context) => (
      // The tile fills whatever column the settings row gives it, so pin that
      // width here rather than letting the centered layout shrink-wrap it.
      <div style={{ width: context.parameters["frameWidth"] as number }}>
        <Story />
      </div>
    ),
  ],
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
    footer: priceFooter("Free Forever"),
  },
};

/**
 * The same free tile with the `obscure-credits` flag on and a usage grant to
 * chart: the Usage Balance bar takes the footer over from "Free Forever", so
 * the tile never states its allowance twice. A free account that was never
 * granted any usage has no bar, and keeps the price row above.
 */
export const CurrentFreeObscuredCredits: Story = {
  args: {
    ...CurrentFree.args,
    specsWrap: true,
    footer: <UsageBalancePanel ratio={0.68} />,
  },
};

/**
 * A subscriber's current-plan tile, on the catalog's Mighty package. The
 * footer price is the fixture's own `total_price_cents` run through the shared
 * `priceLabelFromCents` formatter, so it stays honest if the package is
 * repriced.
 */
export const CurrentPaid: Story = {
  args: {
    testId: "plan-tile-current",
    tierKey: MIGHTY.key,
    name: MIGHTY.name,
    nameTestId: "plan-card-name",
    tag: CURRENT_TAG,
    specs: packageSpecs(MIGHTY, { usageIncludedLabel: "Mighty Usage included" }),
    footer: priceFooter(priceLabelFromCents(MIGHTY.total_price_cents)),
  },
};

/**
 * The same tile with the `obscure-credits` flag on: the credits chip names the
 * package's usage allowance instead of a dollar bundle, the machine and storage
 * chips wrap into a row with that longer chip on its own beneath them, and the
 * price footer gives way to the Usage Balance bar. Props only, so the ratio here
 * is a fixture rather than a live usage read.
 */
export const CurrentObscuredCredits: Story = {
  args: {
    testId: "plan-tile-current",
    tierKey: MIGHTY.key,
    name: MIGHTY.name,
    nameTestId: "plan-card-name",
    tag: CURRENT_TAG,
    specs: packageSpecs(MIGHTY, {
      obscuredUsageLabel: `${MIGHTY.name} usage, reset monthly`,
    }),
    specsWrap: true,
    footer: <UsageBalancePanel ratio={0.42} />,
  },
};

/**
 * The same flag-on tile once the bundle is spent and the wallet behind it is
 * empty. The footer panel turns its bar and reading negative and raises the
 * add-credits strip, which is the tallest the current tile ever gets: compare
 * it against `CurrentPaid` to see how much the footer grows.
 */
export const CurrentObscuredCreditsExhausted: Story = {
  args: {
    ...CurrentObscuredCredits.args,
    footer: <UsageBalancePanel ratio={1} exhausted onAddCredits={() => {}} />,
  },
};

/**
 * A Custom subscriber, whose tier configuration matches no catalog package.
 * `"custom"` is not in the creature trait table, so `PlanTierAvatar` falls back
 * to the Free creature. There is no package to enumerate and no catalog price
 * to quote, so the tile carries neither chips nor a footer.
 */
export const CurrentCustom: Story = {
  args: {
    testId: "plan-tile-current",
    tierKey: "custom",
    name: "Custom",
    nameTestId: "plan-card-name",
    tag: CURRENT_TAG,
    specs: null,
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
    specs: packageSpecs(SUPER, { usageIncludedLabel: "Super Usage included" }),
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
  render: function SideBySideRender() {
    const inverted = useDocumentTheme() === "light" ? "dark" : "light";
    return (
      <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
        <PlanTile
          testId="plan-tile-current"
          tierKey={MIGHTY.key}
          name={MIGHTY.name}
          nameTestId="plan-card-name"
          tag={CURRENT_TAG}
          specs={packageSpecs(MIGHTY, {
            usageIncludedLabel: "Mighty Usage included",
          })}
          footer={priceFooter(priceLabelFromCents(MIGHTY.total_price_cents))}
        />
        <PlanTile
          theme={inverted}
          testId="plan-tile-next"
          tierKey={SUPER.key}
          name={SUPER.name}
          tag={NEXT_PLAN_TAG}
          specs={packageSpecs(SUPER, {
            usageIncludedLabel: "Super Usage included",
          })}
          footer={upgradeCta()}
        />
      </div>
    );
  },
};

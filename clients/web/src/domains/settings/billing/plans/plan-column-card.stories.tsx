/**
 * One pricing column of the View All Plans takeover, and the four-up grid the
 * takeover lays the columns out in. Layout-only, so every column below is a
 * fixture: `plans-page.tsx` owns the catalog, the current-plan decision, and
 * the CTA behaviour. Feature rows are spelled the way `packageFeatures()`
 * there spells them, fed by the shared package fixtures.
 *
 * The takeover forces its near-black canvas whatever the app theme, so the
 * stories mount inside the same `data-theme="dark"` scope and page background.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";

import { frameWidthDecorator } from "@/domains/settings/billing/billing-story-frame";
import type { ProPackage } from "@/domains/settings/billing/package-types";
import { machineLabel } from "@/domains/settings/billing/plan-spec";
import { FREE_STORAGE_GIB } from "@/domains/settings/billing/plan-tier-meta";
import {
  PlanColumnCard,
  type PlanColumnCardProps,
} from "@/domains/settings/billing/plans/plan-column-card";
import { PAGE_BACKGROUND } from "@/domains/settings/billing/plans/plans-canvas";
import {
  downgradeLabel,
  getPlanTierCopy,
} from "@/domains/settings/billing/plans/plans-copy";
import {
  makeProPackage,
  makeSuperPackage,
  makeUltraPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import { priceLabelFromCents } from "@/domains/settings/components/tier-pricing";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

// Every column draws a creature avatar, so warm the bundled-component chunk at
// module scope the way `plans-page.tsx` does.
preloadBundledAvatarComponents();

const MIGHTY = makeProPackage();
const SUPER = makeSuperPackage();
const ULTRA = makeUltraPackage();

/** The grid's `max-w-[1312px]`, where four columns sit at their full width. */
const GRID_WIDTH_PX = 1312;

/** One column of that grid: four across, with three `gap-6` gutters between. */
const COLUMN_WIDTH_PX = (GRID_WIDTH_PX - 3 * 24) / 4;

/** The free column's rows, as `plans-page.tsx` spells them. */
const FREE_FEATURES = [
  "Small Computer",
  `${FREE_STORAGE_GIB} GB Storage`,
  "Pay-as-you-go credits",
];

/** A package's rows: the catalog-derived three, then the tier copy's extras. */
function packageFeatures(pkg: ProPackage): string[] {
  return [
    `${machineLabel(pkg)} Computer`,
    `${pkg.storage_gib} GB Storage`,
    `${pkg.name} usage, reset monthly`,
    ...(getPlanTierCopy(pkg.key)?.extraFeatures ?? []),
  ];
}

/** The props `plans-page.tsx` derives for a catalog package the user can buy. */
function packageColumn(pkg: ProPackage): PlanColumnCardProps {
  const copy = getPlanTierCopy(pkg.key);
  return {
    tierKey: pkg.key,
    name: pkg.name,
    tagline: copy?.tagline ?? "",
    priceLabel: priceLabelFromCents(pkg.total_price_cents),
    priceCaption: copy?.priceCaption ?? "Billed monthly",
    ctaLabel: copy?.cta ?? pkg.name,
    features: packageFeatures(pkg),
    recommended: copy?.recommended,
    tone: copy?.recommended ? "light" : "dark",
    isCurrent: false,
    pending: false,
    onCta: () => {},
  };
}

/** The free tier's column, named "Base" on the takeover, as a free user's own. */
const FREE_COLUMN: PlanColumnCardProps = {
  tierKey: "free",
  name: "Base",
  tagline: getPlanTierCopy("free")?.tagline ?? "",
  priceLabel: "Free",
  priceCaption: "Forever",
  ctaLabel: "Start Free",
  features: FREE_FEATURES,
  tone: "dark",
  isCurrent: true,
  pending: false,
  onCta: () => {},
};

/** The takeover's canvas: its own dark scope over the near-black page. */
const takeoverCanvas: Decorator = (Story) => (
  <div
    data-theme="dark"
    className="w-fit p-6"
    style={{ backgroundColor: PAGE_BACKGROUND }}
  >
    <Story />
  </div>
);

const meta: Meta<typeof PlanColumnCard> = {
  title: "Settings/Billing/PlanColumnCard",
  component: PlanColumnCard,
  parameters: { layout: "centered", frameWidth: COLUMN_WIDTH_PX },
  args: packageColumn(SUPER),
  decorators: [frameWidthDecorator, takeoverCanvas],
};

export default meta;
type Story = StoryObj<typeof PlanColumnCard>;

/**
 * A tier above the user's own: the dark card with the primary CTA carrying
 * the tier copy's label.
 */
export const Upgrade: Story = {};

/**
 * The recommended tier: the one light card among the dark ones, with the
 * "Recommended" chip beside its name.
 */
export const Recommended: Story = {
  args: packageColumn(MIGHTY),
};

/**
 * The user's own tier: the CTA reads "Current Plan" and is disabled, and the
 * recommended chip stays off a card the user already holds.
 */
export const CurrentPlan: Story = {
  args: { ...packageColumn(MIGHTY), isCurrent: true },
};

/**
 * A tier below the user's own: the outlined CTA names the downgrade instead
 * of carrying the tier copy's label.
 */
export const Downgrade: Story = {
  args: {
    ...FREE_COLUMN,
    isCurrent: false,
    ctaLabel: downgradeLabel("Base"),
    intent: "downgrade",
  },
};

/** A checkout in flight: every CTA is disabled until it resolves. */
export const Pending: Story = {
  args: { pending: true },
};

/**
 * The takeover's four-up grid at its full width, the row `plans-page.tsx`
 * renders for a free user. Base and Mighty list three rows where Super and
 * Ultra list four, and the grid's default stretch keeps all four cards at the
 * tallest one's height. Select `Mobile` in the viewport toolbar for the
 * one-up reflow.
 */
export const FourUp: Story = {
  name: "Four-up grid",
  parameters: { controls: { disable: true }, frameWidth: GRID_WIDTH_PX },
  render: () => (
    <div className="grid w-full max-w-[1312px] grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4">
      <PlanColumnCard {...FREE_COLUMN} />
      <PlanColumnCard {...packageColumn(MIGHTY)} />
      <PlanColumnCard {...packageColumn(SUPER)} />
      <PlanColumnCard {...packageColumn(ULTRA)} />
    </div>
  ),
};

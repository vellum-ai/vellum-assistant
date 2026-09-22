/**
 * One pricing column of the View All Plans takeover, and the four-up grid the
 * takeover lays the columns out in. Layout-only, so every column below is a
 * fixture: `plans-page.tsx` owns the catalog, the current-plan decision, and
 * the CTA behaviour. The feature rows come from the helpers the page derives
 * them with, read through the settings catalog, so a story never shows a row
 * the page would not.
 *
 * The takeover forces its near-black canvas whatever the app theme, so the
 * stories mount inside the same `data-theme="dark"` scope and page background.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";

import type {
  ProPackage,
  TierRelation,
} from "@/domains/settings/billing/package-types";
import {
  PlanColumnCard,
  type PlanColumnCardProps,
} from "@/domains/settings/billing/plans/plan-column-card";
import {
  freeColumnFeatures,
  packageColumnFeatures,
  type SettingsTranslate,
} from "@/domains/settings/billing/plans/plan-column-features";
import { PAGE_BACKGROUND } from "@/domains/settings/billing/plans/plans-canvas";
import { getPlanTierCopy } from "@/domains/settings/billing/plans/plans-copy";
import {
  makeProPackage,
  makeSuperPackage,
  makeUltraPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import { priceLabelFromCents } from "@/domains/settings/components/tier-pricing";
import { useTranslation } from "@/i18n";
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

/** The canvas around the frame. */
const CANVAS_PADDING_PX = 24;

/** What a story chooses about the column the page derives. */
interface ColumnArgs {
  /** The catalog package behind the column, or `null` for the free tier. */
  pkg: ProPackage | null;
  isCurrent?: boolean;
  intent?: TierRelation;
  pending?: boolean;
}

/**
 * The props `plans-page.tsx` derives for a catalog package, given how the
 * tier relates to the user's own.
 */
function packageColumn(
  pkg: ProPackage,
  intent: TierRelation,
  t: SettingsTranslate,
): PlanColumnCardProps {
  const copy = getPlanTierCopy(pkg.key);
  return {
    tierKey: pkg.key,
    name: pkg.name,
    tagline: copy?.tagline ?? "",
    priceLabel: priceLabelFromCents(pkg.total_price_cents),
    priceCaption: copy?.priceCaption ?? t("plansPage.billedMonthlyCaption"),
    ctaLabel:
      intent === "downgrade"
        ? t("plansPage.downgradeTo", { name: pkg.name })
        : (copy?.cta ?? pkg.name),
    features: packageColumnFeatures(pkg, copy?.extraFeatures ?? [], t),
    recommended: copy?.recommended,
    tone: copy?.recommended ? "light" : "dark",
    isCurrent: false,
    intent,
    pending: false,
    onCta: () => {},
  };
}

/** The free tier's column, named "Base" on the takeover. */
function freeColumn(
  intent: TierRelation,
  t: SettingsTranslate,
): PlanColumnCardProps {
  const copy = getPlanTierCopy("free");
  return {
    tierKey: "free",
    name: "Base",
    tagline: copy?.tagline ?? "",
    priceLabel: t("plansPage.freePriceLabel"),
    priceCaption: copy?.priceCaption ?? t("plansPage.foreverCaption"),
    ctaLabel:
      intent === "downgrade"
        ? t("plansPage.downgradeTo", { name: "Base" })
        : (copy?.cta ?? t("plansPage.startFreeCta")),
    features: freeColumnFeatures(t),
    tone: "dark",
    isCurrent: false,
    intent,
    pending: false,
    onCta: () => {},
  };
}

/** One column with the page's derivation, read through the settings catalog. */
function Column({
  pkg,
  isCurrent = false,
  intent = "upgrade",
  pending = false,
}: ColumnArgs) {
  const { t } = useTranslation("settings");
  const props = pkg ? packageColumn(pkg, intent, t) : freeColumn(intent, t);
  return <PlanColumnCard {...props} isCurrent={isCurrent} pending={pending} />;
}

/** The grid the page renders for a free user, with the same breakpoints. */
function FourUpGrid() {
  return (
    <div className="grid w-full max-w-[1312px] grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4">
      <Column pkg={null} isCurrent />
      <Column pkg={MIGHTY} />
      <Column pkg={SUPER} />
      <Column pkg={ULTRA} />
    </div>
  );
}

/**
 * The takeover's canvas: its own dark scope over the near-black page. The
 * frame grows to the story's `frameWidth` and shrinks with the viewport below
 * it, as the page does, so the `Mobile` viewport exercises the one-up reflow.
 * That needs the `padded` layout: the centered one shrink-wraps the story
 * root, which collapses a percentage width to the content's own, so the frame
 * centres itself instead.
 */
const takeoverCanvas: Decorator = (Story, context) => (
  <div
    data-theme="dark"
    className="mx-auto w-full"
    style={{
      backgroundColor: PAGE_BACKGROUND,
      padding: CANVAS_PADDING_PX,
      maxWidth:
        (context.parameters.frameWidth ?? COLUMN_WIDTH_PX) +
        CANVAS_PADDING_PX * 2,
    }}
  >
    <Story />
  </div>
);

const meta: Meta<typeof Column> = {
  title: "Settings/Billing/PlanColumnCard",
  component: Column,
  parameters: { layout: "padded" },
  args: { pkg: SUPER },
  argTypes: { pkg: { control: false } },
  decorators: [takeoverCanvas],
};

export default meta;
type Story = StoryObj<typeof Column>;

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
  args: { pkg: MIGHTY },
};

/**
 * The user's own tier: the CTA reads "Current Plan" and is disabled, and the
 * recommended chip stays off a card the user already holds.
 */
export const CurrentPlan: Story = {
  args: { pkg: MIGHTY, isCurrent: true },
};

/**
 * A tier below the user's own: the outlined CTA names the downgrade instead
 * of carrying the tier copy's label.
 */
export const Downgrade: Story = {
  args: { pkg: null, intent: "downgrade" },
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
  render: () => <FourUpGrid />,
};

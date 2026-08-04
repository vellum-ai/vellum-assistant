/**
 * The billing "Plan" section's promo card: the settings-side upsell. Which of
 * its two variants renders is decided in `plan-card.tsx:198-210`:
 *
 *   - **Upgrade to {name}** when a higher package is recommended and the
 *     relation is not a lateral `switch`.
 *   - **Create a custom plan** for a Pro user at the top of the catalog, or one
 *     whose tiers match no package.
 *   - neither → the card does not render at all.
 *
 * Specs come from the production `packageSpecs()` builder fed by the shared
 * package fixtures, so the chips read exactly as they do in the app.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { PlanPromoCard } from "@/domains/settings/billing/plan-promo-card";
import { packageSpecs } from "@/domains/settings/billing/plan-spec";
import {
  makeSuperPackage,
  makeUltraPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";

const meta: Meta<typeof PlanPromoCard> = {
  title: "Upsell Walls/Plan Promo Card",
  component: PlanPromoCard,
  parameters: { layout: "centered" },
  args: {
    onCtaClick: () => {},
    pending: false,
    disabled: false,
  },
  decorators: [
    (Story) => (
      // The card lives in a flex row in the billing panel and is narrow enough
      // that its chip row wraps; pin that width so the story matches.
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof PlanPromoCard>;

/** The upgrade variant, with the target package's spec chips. */
export const UpgradeToPackage: Story = {
  name: "Upgrade to {package}",
  args: {
    title: "Upgrade to Super",
    specs: packageSpecs(makeSuperPackage()),
    ctaLabel: "Upgrade",
    ctaTestId: "recommended-upgrade-button",
  },
};

/** A larger package wraps its chip row rather than truncating. */
export const UpgradeToTopPackage: Story = {
  name: "Upgrade to {package} · wide specs",
  args: {
    title: "Upgrade to Ultra",
    specs: packageSpecs(makeUltraPackage()),
    ctaLabel: "Upgrade",
    ctaTestId: "recommended-upgrade-button",
  },
};

/**
 * The customize variant deliberately carries no spec chips, because there is no target
 * package yet, so there is nothing concrete to advertise.
 */
export const CreateCustomPlan: Story = {
  name: "Create a custom plan",
  args: {
    title: "Create a custom plan",
    ctaLabel: "Customize",
    ctaTestId: "recommended-customize-button",
  },
};

/** Checkout in flight: spinner on the CTA, button disabled. */
export const Pending: Story = {
  args: {
    title: "Upgrade to Super",
    specs: packageSpecs(makeSuperPackage()),
    ctaLabel: "Upgrade",
    pending: true,
  },
};

/**
 * Disabled without a spinner. The customize CTA holds here while the current
 * tier reads settle.
 */
export const Disabled: Story = {
  args: {
    title: "Create a custom plan",
    ctaLabel: "Customize",
    disabled: true,
  },
};

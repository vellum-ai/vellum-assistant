/**
 * Copy for the Pro package-switch confirm modal, keyed by `SwitchRelation`.
 *
 * Pure and catalog-free: the caller supplies the target's display name and
 * tier key, this returns every string the modal renders plus the destructive
 * flag for the confirm CTA.
 */

import type { SwitchRelation } from "@/domains/settings/billing/package-types";
import {
  downgradeLabel,
  getPlanTierCopy,
} from "@/domains/settings/billing/plans/plans-copy";

export interface PackageSwitchCopy {
  /** Header line, e.g. "Upgrade to Mighty". Statement, not a question. */
  title: string;
  /** Tier tagline under the title; empty when the catalog key has no copy. */
  subtitle: string;
  /** Caption under the price — where the money actually lands. */
  priceCaption: string;
  /** Heading above the target package's spec rows. */
  checklistHeading: string;
  /** Extra safeguard prose shown below the checklist; empty when none. */
  note: string;
  /** Full-width primary CTA label. */
  confirmLabel: string;
  /** Render the confirm CTA in the danger variant. */
  destructive: boolean;
}

// Package switches apply immediately (no period-end deferral): an upgrade
// charges the prorated difference now; a downgrade resizes the machine now and
// nets a prorated credit against the next invoice — storage stays, no cash
// refund. The copy must not imply the higher tier is kept until month end.
const UPGRADE_CAPTION = "Billed monthly · prorated difference charged today";
// A Custom sub's direction is unknown, so the neutral caption must name both
// outcomes — a net-cheaper switch credits the next invoice, it is not settled today.
const SWITCH_CAPTION =
  "Billed monthly · prorated difference charged today or credited next invoice";
const DOWNGRADE_CAPTION =
  "Billed monthly · prorated credit on your next invoice";
const DOWNGRADE_NOTE =
  "Your machine downsizes now and your storage stays. No refund.";
const CONTINUE_LABEL = "Continue";
const CHECKLIST_HEADING = "The plan includes";
// The rows enumerate the *lower* package on a downgrade, so a present-tense
// "The plan includes" reads as a list of gains. Future tense keeps it a
// statement of what is left, not what is won.
const DOWNGRADE_CHECKLIST_HEADING = "Your plan will include";

/** Every string the confirm modal renders for one target package. */
export function packageSwitchCopy(
  relation: SwitchRelation,
  packageName: string,
  tierKey: string | null,
): PackageSwitchCopy {
  const subtitle = tierKey ? (getPlanTierCopy(tierKey)?.tagline ?? "") : "";

  switch (relation) {
    case "downgrade":
      return {
        title: `Downgrade to ${packageName}`,
        subtitle,
        priceCaption: DOWNGRADE_CAPTION,
        checklistHeading: DOWNGRADE_CHECKLIST_HEADING,
        note: DOWNGRADE_NOTE,
        confirmLabel: downgradeLabel(packageName),
        destructive: true,
      };
    case "switch":
      return {
        title: `Switch to ${packageName}`,
        subtitle,
        priceCaption: SWITCH_CAPTION,
        checklistHeading: CHECKLIST_HEADING,
        note: "",
        confirmLabel: CONTINUE_LABEL,
        destructive: false,
      };
    default:
      return {
        title: `Upgrade to ${packageName}`,
        subtitle,
        priceCaption: UPGRADE_CAPTION,
        checklistHeading: CHECKLIST_HEADING,
        note: "",
        confirmLabel: CONTINUE_LABEL,
        destructive: false,
      };
  }
}

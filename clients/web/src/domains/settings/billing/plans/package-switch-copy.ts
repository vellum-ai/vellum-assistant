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
  /**
   * Tier tagline under the title. Empty on a downgrade, and whenever the
   * catalog key has no copy — the modal then renders a title-only header and
   * lets the checklist state the specs.
   */
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
// Exported so the modal's and the two page suites' assertions read the copy
// from here rather than re-typing it — a wording edit then fails loudly in one
// place instead of silently breaking three suites.
export const UPGRADE_CAPTION =
  "Billed monthly · prorated difference charged today";
// A Custom sub's direction is unknown, so the neutral caption must name both
// outcomes — a net-cheaper switch credits the next invoice, it is not settled today.
export const SWITCH_CAPTION =
  "Billed monthly · prorated difference charged today or credited next invoice";
export const DOWNGRADE_CAPTION =
  "Billed monthly · prorated credit on your next invoice";
export const DOWNGRADE_NOTE =
  "Your machine downsizes now and your storage stays. No refund.";
export const CONTINUE_LABEL = "Continue";
export const CHECKLIST_HEADING = "The plan includes";
// The rows enumerate the *lower* package on a downgrade, so a present-tense
// "The plan includes" reads as a list of gains. Future tense keeps it a
// statement of what is left, not what is won.
export const DOWNGRADE_CHECKLIST_HEADING = "Your plan will include";

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
        // Same helper as the confirm CTA, so the heading and the button it
        // arms cannot name different packages.
        title: downgradeLabel(packageName),
        // The tagline sells the tier — quoting it under "Downgrade to X" pitches
        // a plan the user is stepping down from. Empty leaves the header to the
        // title, with the checklist below stating what the plan will include.
        subtitle: "",
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

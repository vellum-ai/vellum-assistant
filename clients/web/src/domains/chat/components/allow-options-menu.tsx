import type { ReactElement } from "react";

import { ActionMenu } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

/**
 * The menu of extra allow decisions hung off the chevron half of a
 * confirmation card's split "Allow" button.
 *
 * One component because there are two confirmation cards (the inline one on a
 * tool call and the standalone prompt card) and the menu is the same control in
 * both. It is a domain wrapper rather than a design-library part: the library
 * already ships the primitive this renders, and a menu whose items are this
 * app's permission decisions is the app layer's to name
 * (`packages/design-library/AGENTS.md`, rule 7).
 *
 * `ActionMenu` is what makes the trigger's `aria-haspopup` true rather than
 * decorative. It brings the APG menu-button keyboard pattern and layered
 * dismissal, neither of which a `document` `mousedown` listener over an
 * unlabelled `div` can provide, and it resolves to a bottom sheet under a
 * thumb so the decision stays reachable on touch.
 *
 * The trigger is the caller's element, not this component's: the two cards
 * paint their split pill differently, and that chrome is the only part of the
 * control they do not share. Callers pass the chevron button and style it;
 * everything a user reads or hears belongs to this component, so the accessible
 * name rides on `ActionMenu.Trigger` and Radix's `Slot` merges it onto the
 * caller's element (a prop the child does not set passes through).
 */
export interface AllowOptionsMenuProps {
  /** Which end of the split pill the anchored menu lines up with. */
  align: "start" | "end";
  /** The chevron half of the split pill, styled by the caller. */
  trigger: ReactElement;
  onAllowAndCreateRule: () => void;
}

export function AllowOptionsMenu({
  align,
  trigger,
  onAllowAndCreateRule,
}: AllowOptionsMenuProps) {
  const { t } = useTranslation("chat");
  const label = t("allowOptionsMenu.trigger");

  return (
    <ActionMenu.Root>
      <ActionMenu.Trigger asChild aria-label={label}>
        {trigger}
      </ActionMenu.Trigger>
      <ActionMenu.Content title={label} align={align}>
        <ActionMenu.Item
          label={t("allowOptionsMenu.allowAndCreateRule")}
          onSelect={onAllowAndCreateRule}
        />
      </ActionMenu.Content>
    </ActionMenu.Root>
  );
}

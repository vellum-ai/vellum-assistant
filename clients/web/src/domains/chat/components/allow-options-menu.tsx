import type { ReactElement } from "react";

import { ActionMenu } from "@vellumai/design-library";

/** Names the trigger and the surface, so both presentations announce the same. */
export const ALLOW_OPTIONS_LABEL = "More allow options";

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
 * control they do not share. `ActionMenu` supplies the chevron's
 * `aria-haspopup`, `aria-expanded`, and open handler, so the caller sets only
 * {@link ALLOW_OPTIONS_LABEL} as its accessible name and its own classes.
 */
export function AllowOptionsMenu({
  align,
  trigger,
  onAllowAndCreateRule,
}: {
  /** Which end of the split pill the anchored menu lines up with. */
  align: "start" | "end";
  trigger: ReactElement;
  onAllowAndCreateRule: () => void;
}) {
  return (
    <ActionMenu.Root>
      <ActionMenu.Trigger asChild>{trigger}</ActionMenu.Trigger>
      <ActionMenu.Content title={ALLOW_OPTIONS_LABEL} align={align}>
        <ActionMenu.Item
          label="Allow & Create Rule"
          onSelect={onAllowAndCreateRule}
        />
      </ActionMenu.Content>
    </ActionMenu.Root>
  );
}

/**
 * The pieces the About Assistant layout stories are read with: a stand-in for
 * a section page, the decorators that publish into the layout's slot store the
 * way a section page does, and the phone viewport those stories are drawn for.
 *
 * Shared by `domains/intelligence/intelligence-layout.stories.tsx`, which
 * reads the layout on its own, and `mobile-intelligence-screens.stories.tsx`,
 * which reads it under the real chat header.
 */

import { useEffect, useState, type ComponentProps } from "react";
import { Download, Plus } from "lucide-react";
import type { Decorator } from "@storybook/react-vite";

import { Button } from "@vellumai/design-library";

import { useIntelligenceLayoutSlotsStore } from "@/components/layout/intelligence-layout-slots-store";

/** Stand-in for a section page, so a story renders visible outlet content. */
export function OutletStub({ label }: { label: string }) {
  return (
    <div className="grid h-full w-full place-items-center rounded-md border border-dashed border-[var(--border-element)] text-[var(--content-tertiary)]">
      {label}
    </div>
  );
}

/**
 * Publishes into the layout's slots store the way a section page does, and
 * clears the slot when the story unmounts. A `useState` initializer runs
 * during the decorator's own render, i.e. before the layout below it first
 * samples the store.
 */
export function withSlot(publish: () => void, clear: () => void): Decorator {
  return function WithSlot(Story) {
    useState(publish);
    useEffect(() => clear, []);
    return <Story />;
  };
}

/**
 * Registers one circular pill in the layout's action slot, the shape every
 * section that owns the mobile top bar registers its action as.
 */
function withRegisteredPillAction(
  icon: ComponentProps<typeof Button>["iconOnly"],
  label: string,
): Decorator {
  return withSlot(
    () =>
      useIntelligenceLayoutSlotsStore
        .getState()
        .setHeaderTrailing(
          <Button
            shape="pill"
            variant="ghost"
            iconOnly={icon}
            aria-label={label}
            tooltip={label}
            className="max-md:bg-[var(--surface-active)]"
          />,
        ),
    () => useIntelligenceLayoutSlotsStore.getState().setHeaderTrailing(null),
  );
}

/** The Contacts list's add affordance. */
export const withRegisteredPlus = withRegisteredPillAction(
  <Plus aria-hidden />,
  "Add contact",
);

/** Library's import affordance, the way `LibraryView` registers it on a phone. */
export const withRegisteredImport = withRegisteredPillAction(
  <Download aria-hidden />,
  "Import",
);

/**
 * Reports a pushed detail screen the way a section page does, which is what
 * aims the layout's Back at that section's list.
 */
export const withDetailIsScreen = withSlot(
  () => useIntelligenceLayoutSlotsStore.getState().setDetailIsScreen(true),
  () => useIntelligenceLayoutSlotsStore.getState().setDetailIsScreen(false),
);

/** The phone viewport the mobile stories are drawn for, 390px wide. */
export const phoneGlobals = {
  viewport: { value: "sbMobile", isRotated: false },
};

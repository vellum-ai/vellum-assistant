
import * as Accordion from "@radix-ui/react-accordion";
import { ChevronRight, type LucideIcon } from "lucide-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from "react";

import { cn } from "@vellum/design-library/utils/cn";

/**
 * Collapsible navigation section. A Radix-backed accordion item with a
 * header row that:
 *
 *   - Carries a leading icon which swaps to a disclosure chevron on
 *     hover only. The chevron rotates 90° when expanded (matching
 *     macOS SidebarSectionHeader). The original icon is always
 *     visible when not hovered, regardless of expanded state.
 *   - Takes an optional `trailing` slot for an ellipsis menu, a count
 *     badge, or any other per-row affordance. The trailing slot isolates
 *     pointer events so clicking it doesn't also toggle the section.
 *   - Renders no hover background — keeps the rail quiet. The chevron
 *     swap is the affordance.
 *
 * Use as a compound:
 *
 *   <CollapsibleNavSection.Root type="multiple" defaultValue={["recents"]}>
 *     <CollapsibleNavSection.Section
 *       value="recents"
 *       icon={Clock}
 *       label="Recents"
 *       trailing={<Badge>12</Badge>}
 *     >
 *       {childRows}
 *     </CollapsibleNavSection.Section>
 *   </CollapsibleNavSection.Root>
 *
 * Animations lean on Radix's `--radix-accordion-content-height` variable
 * — see the CSS animations on `.cns-content` at the bottom of this file.
 */

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

type RootProps = ComponentPropsWithoutRef<typeof Accordion.Root>;

const Root = forwardRef<ElementRef<typeof Accordion.Root>, RootProps>(
  function CollapsibleNavSectionRoot({ className, ...props }, ref) {
    return (
      <Accordion.Root
        ref={ref}
        // `gap-2` (8px) separates sibling sections so a stack of
        // collapsed rows doesn't read as a dense list. Consumers can
        // override by passing their own `className`.
        className={cn("flex w-full flex-col gap-2", className)}
        {...props}
      />
    );
  },
);

// ---------------------------------------------------------------------------
// Section — item + trigger + content, composed into a single public API
// ---------------------------------------------------------------------------

export interface CollapsibleNavSectionSectionProps
  extends Omit<ComponentPropsWithoutRef<typeof Accordion.Item>, "children"> {
  /** Radix accordion value — stable key identifying this section. */
  value: string;
  /**
   * Leading icon. Swaps to `ChevronRight` on hover only; the icon
   * returns when not hovered (even when expanded). The chevron rotates
   * 90° when expanded. Omit for sections without an icon — the slot
   * then always shows `ChevronRight` (rotating on expand).
   */
  icon?: LucideIcon;
  /** Row label. */
  label: string;
  /**
   * Trailing slot — typically a badge, count, or "more" menu button.
   * Wrapped in a container that stops pointer events from bubbling, so
   * clicking inside the trailing slot doesn't also toggle the section.
   */
  trailing?: ReactNode;
  /** Section body — rendered inside the collapsible content region. */
  children?: ReactNode;
  /** Optional classes for the inner content block (not the animation wrapper). */
  contentClassName?: string;
}

const Section = forwardRef<
  ElementRef<typeof Accordion.Item>,
  CollapsibleNavSectionSectionProps
>(function CollapsibleNavSectionSection(
  {
    value,
    icon: Icon,
    label,
    trailing,
    children,
    className,
    contentClassName,
    ...itemProps
  },
  ref,
) {
  return (
    <Accordion.Item
      ref={ref}
      value={value}
      className={cn("flex flex-col", className)}
      {...itemProps}
    >
      {/*
       * Header is a flex row containing the Accordion.Trigger (takes
       * flex-1 of the available space) + an optional trailing slot.
       * The trailing slot MUST live outside the Trigger: Accordion.Trigger
       * renders a <button>, and interactive trailing content (menu
       * buttons, link triggers) would nest <button> inside <button>,
       * which is invalid HTML and breaks keyboard / ARIA behavior.
       * The Trigger grabs flex-1 so the clickable area is as wide as
       * possible — only the physical trailing element is non-clickable.
       */}
      <Accordion.Header className="flex items-center">
        <Accordion.Trigger
          className={cn(
            // Mobile: drop the fixed 28px height and bump padding/text so
            // the header reads at the same body-large-default scale as
            // neighbouring `PanelItem` / `SideMenu.Item` rows (~40px tap
            // target). Wider 8px gap matches the Figma 3300:52321 spec.
            "group flex h-[28px] max-md:h-auto min-w-0 flex-1 items-center gap-[4px] max-md:gap-[8px]",
            "rounded-[6px] p-[6px] max-md:px-2 max-md:py-3",
            // typography: off-scale line-height — retains 16px rhythm
            "text-left text-body-small-default leading-[16px] max-md:text-body-large-default",
            "text-[var(--content-tertiary)]",
            // Intentionally no hover background / text color change — the
            // chevron swap is the only affordance per the design.
            "cursor-pointer select-none",
            "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          )}
        >
          <span className="relative inline-flex size-[14px] shrink-0 items-center justify-center">
            {/* Two glyphs overlaid: the section icon (at rest) and a
                ChevronRight (on hover). The chevron rotates 90° when
                expanded, matching macOS SidebarSectionHeader.swift
                where isExpanded only affects rotation while hovered. */}
            {Icon ? (
              <Icon
                size={14}
                aria-hidden
                className={cn(
                  "absolute inset-0 m-auto transition-opacity",
                  "text-[var(--content-tertiary)]",
                  "group-hover:opacity-0 group-focus-visible:opacity-0",
                )}
              />
            ) : null}
            <ChevronRight
              size={14}
              aria-hidden
              className={cn(
                "absolute inset-0 m-auto transition-[opacity,transform]",
                "text-[var(--content-tertiary)]",
                Icon
                  ? "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                  : "opacity-100",
                "group-data-[state=open]:rotate-90",
              )}
            />
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </Accordion.Trigger>
        {trailing ? (
          /*
           * Trailing slot — sibling to the Trigger, not inside it, so
           * interactive trailing content (buttons, Popover triggers)
           * stays HTML-valid. `stopPropagation` here stops a stray
           * bubbling click from reaching the Trigger; interactive
           * children should still own their own event handling.
           */
          <span
            className="cns-trailing flex items-center shrink-0 pr-[6px] max-md:pr-2"
            onClick={(event) => event.stopPropagation()}
          >
            {trailing}
          </span>
        ) : null}
      </Accordion.Header>
      <Accordion.Content
        className={cn(
          // `cns-content` carries the slide-down/up animations — defined
          // in globals.css so Tailwind's arbitrary-keyframe syntax stays
          // out of the component.
          "cns-content overflow-hidden",
          contentClassName,
        )}
      >
        {children}
      </Accordion.Content>
    </Accordion.Item>
  );
});

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

export const CollapsibleNavSection = {
  Root,
  Section,
};

export type CollapsibleNavSectionRootProps = RootProps;

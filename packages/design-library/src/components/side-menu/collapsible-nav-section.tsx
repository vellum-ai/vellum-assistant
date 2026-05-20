import * as Accordion from "@radix-ui/react-accordion";
import { ChevronRight, type LucideIcon } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../../utils/cn.js";

/**
 * Collapsible navigation section — a Radix-backed accordion item with a
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
 * Usage:
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
 * Animations use Radix's `--radix-accordion-content-height` variable —
 * the keyframes are defined in `tokens.css` so they stay out of Tailwind's
 * JIT output.
 */

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

type RootProps = ComponentPropsWithoutRef<typeof Accordion.Root> & {
  ref?: Ref<ElementRef<typeof Accordion.Root>>;
};

function CollapsibleNavSectionRoot({ className, ref, ...props }: RootProps) {
  return (
    <Accordion.Root
      ref={ref}
      data-slot="collapsible-nav-section"
      className={cn("flex w-full flex-col gap-2", className)}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export interface CollapsibleNavSectionSectionProps
  extends Omit<ComponentPropsWithoutRef<typeof Accordion.Item>, "children"> {
  value: string;
  icon?: LucideIcon;
  label: string;
  trailing?: ReactNode;
  children?: ReactNode;
  contentClassName?: string;
  ref?: Ref<ElementRef<typeof Accordion.Item>>;
}

function CollapsibleNavSectionSection({
  value,
  icon: Icon,
  label,
  trailing,
  children,
  className,
  contentClassName,
  ref,
  ...itemProps
}: CollapsibleNavSectionSectionProps) {
  return (
    <Accordion.Item
      ref={ref}
      data-slot="collapsible-nav-section-section"
      value={value}
      className={cn("flex flex-col", className)}
      {...itemProps}
    >
      <Accordion.Header className="flex items-center">
        <Accordion.Trigger
          className={cn(
            "group flex h-[28px] max-md:h-auto min-w-0 flex-1 items-center gap-[4px] max-md:gap-[8px]",
            "rounded-[6px] p-[6px] max-md:px-2 max-md:py-3",
            "text-left text-body-small-default leading-[16px] max-md:text-body-large-default",
            "text-[var(--content-tertiary)]",
            "cursor-pointer select-none",
            "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          )}
        >
          <span className="relative inline-flex size-[14px] shrink-0 items-center justify-center">
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
          "cns-content overflow-hidden",
          contentClassName,
        )}
      >
        {children}
      </Accordion.Content>
    </Accordion.Item>
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

export const CollapsibleNavSection = {
  Root: CollapsibleNavSectionRoot,
  Section: CollapsibleNavSectionSection,
};

export type CollapsibleNavSectionRootProps = RootProps;

import { ChevronRight, type LucideIcon } from "lucide-react";
import { type ReactNode, type Ref } from "react";

import { ContextMenu } from "@vellumai/design-library";
import {
    Collapsible,
    type CollapsibleItemProps,
    type CollapsibleRootProps,
} from "@vellumai/design-library/components/collapsible";
import { cn } from "@vellumai/design-library/utils/cn";

import {
    SIDEBAR_CHIP_GAP,
    SIDEBAR_CHIP_SIZE,
    SIDEBAR_ROW_PADDING_X,
} from "@/components/sidebar-nav-geometry";

/**
 * Navigation-specific collapsible section — composes the design library
 * `Collapsible` primitive with sidebar-tuned trigger styling:
 *
 *   - Leading icon that swaps to a disclosure chevron on hover
 *     (matching macOS SidebarSectionHeader). The original icon is
 *     always visible when not hovered, regardless of expanded state.
 *   - Optional `trailing` slot for an ellipsis menu or other per-row
 *     affordance. Pointer events are isolated so clicking trailing
 *     content doesn't toggle the section.
 *   - No hover background — the chevron swap is the affordance.
 *
 * Usage:
 *
 *   <CollapsibleNavSection.Root type="multiple" defaultValue={["scheduled"]}>
 *     <CollapsibleNavSection.Section
 *       value="scheduled"
 *       icon={Clock}
 *       label="Scheduled"
 *       trailing={<MenuButton />}
 *     >
 *       {childRows}
 *     </CollapsibleNavSection.Section>
 *   </CollapsibleNavSection.Root>
 */

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function CollapsibleNavSectionRoot({
  className,
  ref,
  ...props
}: CollapsibleRootProps) {
  return (
    <Collapsible.Root
      ref={ref}
      className={cn("gap-2", className)}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export interface CollapsibleNavSectionSectionProps
  extends Omit<CollapsibleItemProps, "children"> {
  value: string;
  icon?: LucideIcon;
  label: string;
  trailing?: ReactNode;
  contextMenuContent?: ReactNode;
  /**
   * Activity indicator rendered inline in the header, but only while the
   * section is collapsed — when open, the child rows show their own
   * indicators, so a header dot would be redundant.
   */
  collapsedIndicator?: ReactNode;
  children?: ReactNode;
  contentClassName?: string;
  ref?: Ref<HTMLDivElement>;
}

function CollapsibleNavSectionSection({
  value,
  icon: Icon,
  label,
  trailing,
  contextMenuContent,
  collapsedIndicator,
  children,
  className,
  contentClassName,
  ref,
  ...itemProps
}: CollapsibleNavSectionSectionProps) {
  const headerEl = (
    <div data-slot="collapsible-nav-section-header" className="flex items-center justify-between">
      {/* The horizontal geometry (padding, chip width, gap) is inline from
          sidebar-nav-geometry at every breakpoint — the assistant cluster
          shares it, so section icons and labels sit on the same axes as
          the New Chat plus and the assistant eyes. Only the vertical
          metrics grow on mobile. */}
      <Collapsible.Trigger
        className={cn(
          "group h-[30px] max-md:h-auto",
          "rounded-[6px] py-[6px] max-md:py-3",
          "text-left text-body-medium-default max-md:text-body-large-default",
          "text-[var(--content-tertiary)]",
        )}
        style={{
          paddingLeft: SIDEBAR_ROW_PADDING_X,
          paddingRight: SIDEBAR_ROW_PADDING_X,
          gap: SIDEBAR_CHIP_GAP,
        }}
      >
        <span
          className="relative inline-flex h-[14px] shrink-0 items-center justify-center"
          style={{ width: SIDEBAR_CHIP_SIZE }}
        >
          {Icon ? (
            <Icon
              size={12}
              aria-hidden
              className={cn(
                "absolute inset-0 m-auto transition-opacity",
                "text-[var(--content-tertiary)]",
                "group-hover:opacity-0 group-focus-visible:opacity-0",
              )}
            />
          ) : null}
          <ChevronRight
            size={12}
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
        {collapsedIndicator ? (
          <span className="ml-1 flex shrink-0 items-center group-data-[state=open]:hidden">
            {collapsedIndicator}
          </span>
        ) : null}
      </Collapsible.Trigger>
      {trailing ? (
        <span
          className="flex items-center shrink-0 pr-[6px] max-md:pr-2"
          onClick={(event) => event.stopPropagation()}
        >
          {trailing}
        </span>
      ) : null}
    </div>
  );

  return (
    <Collapsible.Item
      ref={ref}
      data-slot="collapsible-nav-section-section"
      value={value}
      className={className}
      {...itemProps}
    >
      {contextMenuContent ? (
        <ContextMenu.Root>
          <ContextMenu.Trigger>{headerEl}</ContextMenu.Trigger>
          <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
            {contextMenuContent}
          </ContextMenu.Content>
        </ContextMenu.Root>
      ) : headerEl}
      <Collapsible.Content className={contentClassName}>
        {children}
      </Collapsible.Content>
    </Collapsible.Item>
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

export const CollapsibleNavSection = {
  Root: CollapsibleNavSectionRoot,
  Section: CollapsibleNavSectionSection,
};

export type CollapsibleNavSectionRootProps = CollapsibleRootProps;

import { ChevronRight, type LucideIcon } from "lucide-react";
import { type ReactNode, type Ref } from "react";

import { ContextMenu } from "@vellumai/design-library";
import {
    Collapsible,
    type CollapsibleItemProps,
    type CollapsibleRootProps,
} from "@vellumai/design-library/components/collapsible";
import { cn } from "@vellumai/design-library/utils/cn";

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
  children,
  className,
  contentClassName,
  ref,
  ...itemProps
}: CollapsibleNavSectionSectionProps) {
  const headerEl = (
    <div data-slot="collapsible-nav-section-header" className="flex items-center justify-between">
      <Collapsible.Trigger
        className={cn(
          "group h-[30px] max-md:h-auto gap-[4px] max-md:gap-[8px]",
          "rounded-[6px] p-[6px] max-md:px-2 max-md:py-3",
          "text-left text-body-medium-default max-md:text-body-large-default",
          "text-[var(--content-tertiary)]",
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

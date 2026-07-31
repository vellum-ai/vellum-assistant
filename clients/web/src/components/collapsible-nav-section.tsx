import { ChevronRight, type LucideIcon } from "lucide-react";
import { type DragEvent, type ReactNode, type Ref } from "react";

import { BottomSheet, ContextMenu } from "@vellumai/design-library";
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
  SIDEBAR_SECTION_INDENT,
} from "@/components/sidebar-nav-geometry";
import { useLongPressSheet } from "@/hooks/use-long-press-sheet";
import { isPointerCoarse } from "@/utils/pointer";

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
 *   - Optional header menu, in two surfaces: `contextMenuContent`
 *     (desktop right-click) and `touchMenuContent` (touch long-press →
 *     bottom sheet). Supply both so the actions are reachable on every
 *     pointer type — Radix `ContextMenu` alone renders a pointer-positioned
 *     popover on touch, which is the wrong surface on mobile. Mirrors the
 *     conversation-row long-press pattern.
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
    <Collapsible.Root ref={ref} className={cn("gap-2", className)} {...props} />
  );
}

// ---------------------------------------------------------------------------
// Touch header menu
// ---------------------------------------------------------------------------

/** The trailing "…" control owns its own taps, so it never arms the gesture. */
const skipTrailingControl = (target: Element | null) =>
  Boolean(target?.closest('[data-slot="collapsible-nav-section-trailing"]'));

/**
 * Wraps a section header so a long-press opens its actions in a bottom sheet.
 * The sheet is a sibling of the gesture wrapper, not a child — see
 * {@link useLongPressSheet}.
 */
function LongPressHeaderMenu({
  title,
  content,
  children,
}: {
  title: string;
  content: (close: () => void) => ReactNode;
  children: ReactNode;
}) {
  const longPress = useLongPressSheet({ shouldSkip: skipTrailingControl });

  return (
    <>
      <div {...longPress.wrapperProps}>{children}</div>
      <BottomSheet.Root
        open={longPress.open}
        onOpenChange={longPress.onOpenChange}
      >
        <BottomSheet.Content aria-describedby={undefined}>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>{title} actions</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">
            {content(longPress.close)}
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    </>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

/**
 * Drag-to-reorder wiring for a whole section.
 *
 * Every handler goes on the **header** - it is both the drag handle and the
 * drop target - while the visual state (`dragging`, `dropEdge`) styles the
 * whole section box.
 *
 * The header, not the section root, owns the handlers deliberately.
 * `dragleave` bubbles, so a section root that is also the drop target
 * receives leave events from each of its own conversation rows as the pointer
 * crosses them; those have a `relatedTarget` outside the root, so the drop
 * indicator gets cleared on the way past an expanded section. Keeping the
 * handlers on one flat element (the same shape a conversation row uses)
 * removes that class of bug: leaves between the header's own children always
 * resolve to a descendant and are correctly ignored.
 *
 * Structural on purpose - this component sits in shared `components/` and
 * shouldn't reach into the chat domain's drag hook for a type.
 */
export interface CollapsibleNavSectionDrag {
  headerProps: {
    draggable: true;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  /** True while this section is the one being dragged. */
  dragging: boolean;
  /** Edge to draw the insertion line on while hovered, else null. */
  dropEdge: "before" | "after" | null;
}

export interface CollapsibleNavSectionSectionProps extends Omit<
  CollapsibleItemProps,
  "children"
> {
  value: string;
  icon?: LucideIcon;
  label: string;
  trailing?: ReactNode;
  contextMenuContent?: ReactNode;
  /**
   * Touch equivalent of `contextMenuContent` — rendered as the body of a
   * long-press bottom sheet. Receives a `close` callback so rows can dismiss
   * the sheet after running their action.
   */
  touchMenuContent?: (close: () => void) => ReactNode;
  /**
   * Activity indicator rendered inline in the header, but only while the
   * section is collapsed — when open, the child rows show their own
   * indicators, so a header dot would be redundant.
   */
  collapsedIndicator?: ReactNode;
  /** Drag-to-reorder wiring; omit to leave the section fixed in place. */
  drag?: CollapsibleNavSectionDrag;
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
  touchMenuContent,
  collapsedIndicator,
  drag,
  children,
  className,
  contentClassName,
  ref,
  ...itemProps
}: CollapsibleNavSectionSectionProps) {
  const headerEl = (
    <div
      data-slot="collapsible-nav-section-header"
      className={cn(
        "flex items-center justify-between",
        drag && "cursor-grab active:cursor-grabbing",
      )}
      {...drag?.headerProps}
    >
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
          data-slot="collapsible-nav-section-trailing"
          /* `empty:hidden` so a trailing component that renders nothing (a
             menu with no wired actions) doesn't leave a padded box behind. */
          className="flex items-center shrink-0 pr-[6px] max-md:pr-2 empty:hidden"
          onClick={(event) => event.stopPropagation()}
        >
          {trailing}
        </span>
      ) : null}
    </div>
  );

  // Touch devices replace the right-click ContextMenu with a long-press sheet.
  // The gesture state lives in a child component so its hooks mount only on
  // the surfaces that use them.
  const header =
    isPointerCoarse() && touchMenuContent ? (
      <LongPressHeaderMenu title={label} content={touchMenuContent}>
        {headerEl}
      </LongPressHeaderMenu>
    ) : contextMenuContent ? (
      <ContextMenu.Root>
        <ContextMenu.Trigger>{headerEl}</ContextMenu.Trigger>
        <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
          {contextMenuContent}
        </ContextMenu.Content>
      </ContextMenu.Root>
    ) : (
      headerEl
    );

  return (
    <Collapsible.Item
      ref={ref}
      data-slot="collapsible-nav-section-section"
      value={value}
      /* Visual state only - the handlers live on the header (see
         {@link CollapsibleNavSectionDrag}). Drawing the insertion line on the
         whole section box, rather than on the header strip, keeps "lands after
         this section" from reading as "lands inside it" when the section is
         expanded. */
      className={cn(
        drag?.dragging && "opacity-50",
        // Insertion line, matching the conversation-row drop indicator.
        drag?.dropEdge === "before" &&
          "shadow-[inset_0_2px_0_0_var(--primary-base)]",
        drag?.dropEdge === "after" &&
          "shadow-[inset_0_-2px_0_0_var(--primary-base)]",
        className,
      )}
      {...itemProps}
    >
      {header}
      {/* One indent for every section's content, defined here rather than at
          each call site so no section can nest differently from the rest. */}
      <Collapsible.Content
        className={contentClassName}
        style={{ paddingLeft: SIDEBAR_SECTION_INDENT }}
      >
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

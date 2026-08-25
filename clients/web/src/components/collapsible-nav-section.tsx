import { ChevronDown, type LucideIcon } from "lucide-react";
import { useRef, type DragEvent, type ReactNode, type Ref } from "react";

import {
  BottomSheet,
  ContextMenu,
  CrossfadeStack,
  SideMenu,
} from "@vellumai/design-library";
import {
  Collapsible,
  type CollapsibleItemProps,
  type CollapsibleRootProps,
} from "@vellumai/design-library/components/collapsible";
import { cn } from "@vellumai/design-library/utils/cn";

import {
  SIDEBAR_CHIP_GAP,
  SIDEBAR_ROW_PADDING_X,
  SIDEBAR_SECTION_INDENT,
  SIDEBAR_SECTION_TITLE_TEXT_CLASSES,
} from "@/components/sidebar-nav-geometry";
import { useLongPressSheet } from "@/hooks/use-long-press-sheet";
import { useTranslation } from "@/i18n";
import { isPointerCoarse } from "@/utils/pointer";

/**
 * Navigation-specific collapsible section — composes the design library
 * `Collapsible` primitive with sidebar-tuned trigger styling:
 *
 *   - Leading icon, at every state. `sectionIcon` is the single answer to
 *     "what does this section look like", so a header and its collapsed-rail
 *     tile show the same glyph; omit `icon` only for a section that has
 *     none.
 *   - The title row is the one toggle target: a click
 *     expands or collapses the section, while click-and-hold-and-move
 *     still drags it (see `drag`): HTML5 drag only starts on movement,
 *     so the two coexist on one surface. The chevron on the trailing
 *     edge, left of the "…", is a decorative indicator that forwards its
 *     clicks to that trigger, revealed only on hover, not on
 *     click-then-release focus, which would otherwise linger after the
 *     click that opened/closed it, and not just because the section is
 *     open.
 *   - Optional `trailing` slot for an ellipsis menu or other per-row
 *     affordance. Pointer events are isolated so clicking trailing
 *     content doesn't toggle the section.
 *   - Optional header menu, in two surfaces: `contextMenuContent`
 *     (desktop right-click) and `touchMenuContent` (touch long-press →
 *     bottom sheet). Supply both so the actions are reachable on every
 *     pointer type — Radix `ContextMenu` alone renders a pointer-positioned
 *     popover on touch, which is the wrong surface on mobile. Mirrors the
 *     conversation-row long-press pattern.
 *   - No hover background on the title; the chevron's own hover box is
 *     the affordance.
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
  const { t } = useTranslation();
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
            <BottomSheet.Title>
              {t("collapsibleNavSection.actionsTitle", { title })}
            </BottomSheet.Title>
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

interface CollapsibleNavSectionSectionProps extends Omit<
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
  /**
   * Draw the section as a self-contained card rather than a run of rows on
   * the panel's own surface. The card owns the horizontal inset, so the
   * header and the list inside it sit flush and the header shrinks to a bare
   * label row. The caller supplies the surface and radius through
   * `className`; this governs the geometry that has to agree with it.
   */
  card?: boolean;
  /**
   * Whether the section can collapse. Defaults to `true`. `false` drops the
   * chevron/icon-swap affordance and the header's toggle behavior entirely,
   * and renders the content outside the Radix accordion machinery so it's
   * always visible regardless of the root's open-section state.
   */
  collapsible?: boolean;
  /**
   * Skips the "grow to fill the sidebar's remaining space while open" sizing
   * below. Pinned wants this: it grows to fit its own rows instead, and
   * should never stretch to claim space its rows don't use.
   */
  unbounded?: boolean;
  /**
   * Whether this is the bottom-most section in the list - only it grows to
   * fill leftover space while open; every section above it (even open, even
   * busy) sizes to its own content instead, since flex-grow would otherwise
   * hand every open section a share of the leftover space whether or not it
   * has enough rows to use it.
   */
  isLast?: boolean;
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
  collapsible = true,
  unbounded = false,
  isLast = false,
  card = false,
  ...itemProps
}: CollapsibleNavSectionSectionProps) {
  // The chevron forwards its clicks to the title trigger, keeping one
  // accessible toggle per section.
  const titleTriggerRef = useRef<HTMLButtonElement>(null);

  /* One slot for both header branches. The collapsible and non-collapsible
     headers show the same glyph on the same axis, so they read it from here
     rather than each rendering their own copy. */
  const iconSlot = Icon ? (
    <span
      data-slot="collapsible-nav-section-icon"
      /* Hugs the glyph. A chip-width box with the glyph centred in it padded
         the icon away from both edges, so the header read as indented from
         the row surfaces below it. Centring is the collapsed rail's need,
         and the rail draws its own tiles. */
      className="relative inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center"
    >
      <Icon size={12} aria-hidden className="text-[var(--content-tertiary)]" />
    </span>
  ) : null;

  /* Both header branches are the same row: one is a disclosure trigger and
     the other is inert, so the geometry and the content are declared once and
     the branch below chooses only the element. */
  /* A card supplies the section's own inset, so the header sits flush
     inside it as a bare 16px row with the smaller of the two title sizes. */
  const titleClasses = cn(
    card ? "py-0" : "py-[6px] max-md:py-3",
    SIDEBAR_SECTION_TITLE_TEXT_CLASSES,
    /* `!` twice over: the shared title classes pin their own weight the same
       way, so a plain utility here loses to them rather than replacing them. */
    card && "text-body-small-default max-md:text-body-small-default font-[500]!",
  );

  const titleStyle = {
    paddingLeft: card ? 0 : SIDEBAR_ROW_PADDING_X,
    paddingRight: card ? 0 : SIDEBAR_ROW_PADDING_X,
    gap: SIDEBAR_CHIP_GAP,
  };

  const titleContent = (
    <>
      {iconSlot}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </>
  );

  const headerEl = (
    <div
      data-slot="collapsible-nav-section-header"
      /* The hover scope for the trailing "…": hovering anywhere on the header
         reveals it. Attribute-keyed rather than a Tailwind group, so the
         trigger's own unnamed `group` (the icon/chevron swap) cannot answer to
         it and this cannot answer to the trigger's. */
      data-reveal-row=""
      className={cn(
        "flex shrink-0 items-center justify-between",
        // The title trigger's Accordion.Header wrapper must grow to fill
        // the row, so the whole header (minus the trailing cluster) is
        // the click target and long labels still truncate. The primitive
        // hardcodes `flex` on it, so the growth comes from here.
        "[&>[data-slot=collapsible-header]]:min-w-0 [&>[data-slot=collapsible-header]]:flex-1",
        /* A card's header row, sized so that with the card's 12px vertical
           inset the collapsed pill lands on the overlay tile size (44px).
           The controls beside it are touch targets rather than content, so
           they keep their own size and centre-overflow this row instead of
           setting it; the card's top padding is deeper than the overflow,
           so nothing escapes the card. */
        card && "h-5",
        drag && "cursor-grab active:cursor-grabbing",
      )}
      {...drag?.headerProps}
    >
      {/* The horizontal geometry (padding, chip width, gap) is inline from
          sidebar-nav-geometry at every breakpoint — the assistant cluster
          shares it, so section icons and labels sit on the same axes as
          the New Chat plus and the assistant eyes. Only the vertical
          metrics grow on mobile. */}
      {collapsible ? (
        // The one toggle target: a click anywhere on the title row expands
        // or collapses the section, while click-and-hold-and-move drags it
        // (native HTML5 drag on the header div, see `drag` below). The
        // chevron in the trailing cluster forwards its clicks here.
        <SideMenu.SectionHeader
          asChild
          className={titleClasses}
          style={titleStyle}
        >
          <Collapsible.Trigger
            ref={titleTriggerRef}
            data-slot="collapsible-nav-section-title"
          >
            {titleContent}
          </Collapsible.Trigger>
        </SideMenu.SectionHeader>
      ) : (
        // Non-collapsible: no chevron, no toggle affordance, just the icon
        // slot (if given) and the label, always at rest. Half the usual
        // mobile bottom padding: the gap to the first row below reads as too
        // large at the full py-3.
        <SideMenu.SectionHeader
          className={cn(titleClasses, "max-md:pt-3 max-md:pb-1.5")}
          style={titleStyle}
        >
          {titleContent}
        </SideMenu.SectionHeader>
      )}
      {collapsible || trailing || collapsedIndicator ? (
        <span className="flex shrink-0 items-center gap-1 pr-[6px] max-md:pr-2">
          {trailing || collapsedIndicator ? (
            <CrossfadeStack>
              {collapsedIndicator ? (
                /* Only while collapsed: an open section's rows carry the same
                   state, so a header dot would double it. `pointer-events-none`
                   because it is painted over the menu button it shares a cell
                   with. */
                <span
                  data-slot="collapsible-nav-section-indicator"
                  /* Yields the cell on exactly the conditions that bring the
                     trailing control in, or the two paint over each other. With
                     no trailing control there is nothing to yield to, and a
                     section whose only header signal is this dot keeps it
                     wherever the device cannot hover. */
                  data-reveal-yield={trailing ? "" : undefined}
                  className={cn(
                    "pointer-events-none flex items-center",
                    "group-data-[state=open]/section:hidden",
                  )}
                >
                  {collapsedIndicator}
                </span>
              ) : null}
              {trailing ? (
                <span
                  data-slot="collapsible-nav-section-trailing"
                  /* `empty:hidden` so a trailing component that renders nothing
                     doesn't leave a padded box behind. */
                  data-reveal=""
                  className="flex items-center shrink-0 empty:hidden"
                  onClick={(event) => event.stopPropagation()}
                >
                  {trailing}
                </span>
              ) : null}
            </CrossfadeStack>
          ) : null}
          {collapsible ? (
            // Decorative disclosure indicator with the title trigger's own
            // hover box, outermost so the "…" sits inside it and the
            // header's right edge stays the same glyph whichever is
            // showing. Not a trigger itself: the section
            // has exactly one accessible toggle (the title), so the chevron
            // stays out of the accessibility tree and forwards pointer
            // clicks to that trigger instead. A second Radix trigger here
            // would duplicate the item's trigger id and announce every
            // section twice.
            <span
              data-slot="collapsible-nav-section-chevron"
              aria-hidden
              onClick={(event) => {
                event.stopPropagation();
                titleTriggerRef.current?.click();
              }}
              className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[4px] hover:bg-[var(--surface-hover)] max-md:h-[30px] max-md:w-[30px]"
            >
              <ChevronDown
                size={12}
                aria-hidden
                className={cn(
                  "shrink-0 transition-transform",
                  "text-[var(--content-tertiary)]",
                  "max-md:h-[18px] max-md:w-[18px]",
                  "group-data-[state=open]/section:rotate-180",
                )}
              />
            </span>
          ) : null}
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
        // Named so the trailing chevron (a header-level sibling of the
        // Trigger, not a descendant) can read this item's own open/closed
        // `data-state` for its rotation.
        "group/section",
        // While open, only the bottom-most section grows to claim whatever
        // space the sidebar has left instead of the row list capping at a
        // fixed height - `min-h-0` is what lets a flex item shrink below its
        // content's natural size, which flex-1 needs here to actually cap
        // rather than just growing forever. Every other section (even open,
        // even unbounded) sizes to its own content: flex-grow has no notion
        // of "this section needs the room," so giving every open section a
        // share stretched a two-row group into a mostly-empty box the same
        // size as a busy one beside it.
        !unbounded &&
          isLast &&
          "data-[state=open]:min-h-0 data-[state=open]:flex-1",
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
      {/*
       * The card carries no padding of its own (the header row above is
       * already a self-contained pill), so the content picks up the same
       * 12px horizontal inset directly, plus a little vertical breathing
       * room from the header above it and the card's bottom edge below.
       * Defined here rather than at each call site so no section can nest
       * differently from the rest.
       */}
      {collapsible ? (
        <Collapsible.Content
          className={cn(
            "sidebar-section-list",
            card
              ? "pt-3 [&_[data-slot=side-menu-sub-list]]:gap-0"
              : "pt-2 pb-2",
            !unbounded && isLast && "flex min-h-0 flex-1 flex-col",
            contentClassName,
          )}
          style={{
            paddingLeft: card ? 0 : SIDEBAR_ROW_PADDING_X + SIDEBAR_SECTION_INDENT,
            paddingRight: card ? 0 : SIDEBAR_ROW_PADDING_X,
          }}
        >
          {children}
        </Collapsible.Content>
      ) : (
        // Bypasses Radix's open/closed accordion state entirely, so the
        // content can't be collapsed even if this section's `value` isn't
        // in the root's open list.
        <div
          className={cn(
            card
              ? "pt-3 [&_[data-slot=side-menu-sub-list]]:gap-0"
              : "pt-2 pb-2",
            contentClassName,
          )}
          style={{
            paddingLeft: card ? 0 : SIDEBAR_ROW_PADDING_X + SIDEBAR_SECTION_INDENT,
            paddingRight: card ? 0 : SIDEBAR_ROW_PADDING_X,
          }}
        >
          {children}
        </div>
      )}
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

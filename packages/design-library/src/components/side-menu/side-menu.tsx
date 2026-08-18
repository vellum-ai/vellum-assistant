import type { LucideIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";

import { Slot } from "@radix-ui/react-slot";

import { Typography } from "../typography";
import { Tooltip } from "../tooltip";
import { PaneResizeHandle } from "../pane-resize-handle";
import { useResizablePane } from "../../hooks/use-resizable-pane";
import { cn } from "../../utils/cn";
import { reportUnmergeableSlotChild } from "../../utils/slot-child";
import type { CustomPropertyStyle } from "../../utils/custom-property-style";

/**
 * SideMenu primitive — a docked application navigation rail.
 *
 * Two variants:
 * - `rail` (default) — desktop, docked left. Supports a `collapsed` state
 *   that shrinks the rail to a column one icon tile wide. When collapsed,
 *   section titles, sublists, labels, badges, and trailing icons are
 *   suppressed via a shared context so consumers never conditionally render
 *   child content themselves.
 * - `overlay` — mobile, full-bleed. `collapsed` is ignored (labels always
 *   render) and the radius goes to 0 to read as a full-height drawer.
 *
 * Compound API:
 *
 *   SideMenu
 *     ├── SideMenu.Header        — top slot (non-scrolling)
 *     ├── SideMenu.Body          — scrolling middle; flex-1
 *     │   ├── SideMenu.Section   — labeled group with optional `actions`
 *     │   │   └── SideMenu.SubList
 *     │   │       └── SideMenu.Item
 *     │   ├── SideMenu.SectionHeader: title row of a caller-drawn group
 *     │   └── SideMenu.Separator
 *     └── SideMenu.Footer        — bottom slot (sticks via margin-top: auto)
 *
 * All colors come from semantic tokens (`--surface-overlay`, `--content-default`,
 * `--border-base`, etc.). Zero hex literals live in this file.
 */

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type SideMenuVariant = "rail" | "overlay";

interface SideMenuContextValue {
  collapsed: boolean;
  /** Content-level collapsed — lags behind `collapsed` when expanding so
   *  labels appear after the width transition finishes. */
  contentCollapsed: boolean;
  variant: SideMenuVariant;
}

const SideMenuContext = createContext<SideMenuContextValue>({
  collapsed: false,
  contentCollapsed: false,
  variant: "rail",
});

function useSideMenuContext(): SideMenuContextValue {
  return useContext(SideMenuContext);
}

/**
 * Whether content (labels, sublists, section headers) should be hidden.
 * Uses the delayed `contentCollapsed` so content lingers while the width
 * transition completes on collapse.
 */
function isCollapsedRail(ctx: SideMenuContextValue): boolean {
  return ctx.variant === "rail" && ctx.contentCollapsed;
}

/**
 * The same question against the rail's *immediate* collapsed state, with no
 * transition delay.
 *
 * Only for content that has no label to linger over, and whose call site
 * mounts it on the same immediate flag. {@link isCollapsedRail} is the default
 * for everything else: the lag is what lets a label stay put while the rail
 * narrows around it.
 */
function isCollapsingRail(ctx: SideMenuContextValue): boolean {
  return ctx.variant === "rail" && ctx.collapsed;
}

/**
 * Whether a rail entry should render in its collapsed form, for the entries
 * this package does not draw itself.
 *
 * A caller supplying its own trigger through a slot needs the same answer
 * `SideMenu.Item` gets, and it has to be the delayed one: the lag is what
 * keeps a label from painting into a rail that is still narrowing around it.
 * Reading it here rather than accepting it as a prop is what keeps the slot's
 * content from disagreeing with the menu it sits in, since the two cannot then
 * be derived from different sources.
 */
function useSideMenuCollapsed(): boolean {
  return isCollapsedRail(useSideMenuContext());
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const SIDE_MENU_DEFAULT_WIDTH = 230;
export const SIDE_MENU_MIN_WIDTH = 220;
export const SIDE_MENU_MAX_WIDTH = 400;

/**
 * The height of a top-level rail pill (an assistant identity row, New Chat, a
 * pinned app, a section header, Preferences), and so also the diameter of the
 * circle each of those becomes when the rail collapses: a tile is one of those
 * pills with its label taken away, and holding the pill's height is what keeps
 * its glyph on the axis the expanded pill puts it on.
 *
 * A list row keeps its own denser height: the rail collapses cards and pills
 * into tiles, and a conversation row is neither.
 *
 * Exported so a caller drawing its own tile sizes it from here rather than
 * from a matching literal, which is the only way the column stays one width.
 * A `PanelItem` pill needs nothing: the rail publishes this as
 * `--side-menu-tile-size` and the pill shape reads it, so its height is not a
 * caller's decision.
 */
export const SIDE_MENU_TILE_SIZE = 36;

/**
 * The rail's default horizontal padding, which is also the inset `PanelItem`
 * holds its leading icon at (`p-[8px]`), so an expanded pill's glyph and a
 * collapsed tile's glyph land on the same axis.
 */
export const SIDE_MENU_COLLAPSED_INSET = 8;

/** The rail's default card edge, on both sides. */
export const SIDE_MENU_BORDER_WIDTH = 1;

/**
 * The collapsed rail's outer width with the rail's default chrome, for callers
 * that need the number in JS (an animation target, a reserved gutter).
 *
 * It is the sum rather than a literal, and the border is part of the sum: the
 * rail is a `border-box` element, so a number that counts only the tile and
 * its padding spends 2px of itself on the edge and leaves the tile 2px less
 * room than it needs.
 *
 * The rendered width is not this constant. The collapsed rail declares one
 * tile of *content* ({@link SIDE_MENU_TILE_SIZE} with `box-content`) and lets
 * its own padding and border add themselves, so a caller that overrides that
 * chrome (`p-0`, `border-0`, as a caller drawing the card edge itself does)
 * gets a rail exactly one tile wide instead of one that keeps padding it never
 * renders. That is what makes collapsing read as a pill shrinking in place: a
 * rail wider than its tile has spare room, the tile centres in it, and every
 * glyph steps inward by half the surplus.
 */
export const SIDE_MENU_COLLAPSED_WIDTH =
  SIDE_MENU_TILE_SIZE +
  SIDE_MENU_COLLAPSED_INSET * 2 +
  SIDE_MENU_BORDER_WIDTH * 2;

/**
 * The geometry above, published to CSS so the classes below can read it. The
 * alternative is Tailwind arbitrary values holding the same pixels a second
 * time, which cannot be checked against the constants and is what lets the
 * rail and its tiles disagree.
 */
const RAIL_GEOMETRY_VARS: CustomPropertyStyle = {
  "--side-menu-tile-size": `${SIDE_MENU_TILE_SIZE}px`,
  "--side-menu-collapsed-inset": `${SIDE_MENU_COLLAPSED_INSET}px`,
};

/**
 * A touch surface stands its tiles taller than a pointer one, so the overlay
 * publishes its own tile size and every pill mounted in it follows without
 * each caller restating a height.
 */
export const SIDE_MENU_OVERLAY_TILE_SIZE = 44;

/**
 * How far the overlay holds its content off the screen edge. Published as
 * well as applied, because anything positioned against the sheet's own edge
 * rather than the body's has to subtract it to land where the body stops.
 */
export const SIDE_MENU_OVERLAY_INSET = 12;

const OVERLAY_VARS: CustomPropertyStyle = {
  ...RAIL_GEOMETRY_VARS,
  "--side-menu-tile-size": `${SIDE_MENU_OVERLAY_TILE_SIZE}px`,
  "--side-menu-inset": `${SIDE_MENU_OVERLAY_INSET}px`,
};

export interface SideMenuProps extends ComponentProps<"nav"> {
  /** Ignored when `variant="overlay"`. */
  collapsed?: boolean;
  /** `rail` = desktop docked; `overlay` = mobile full-bleed. */
  variant?: SideMenuVariant;
  /** Required for the `navigation` landmark role. */
  ariaLabel: string;
  /** Custom width in pixels (rail variant only). Ignored when collapsed. */
  width?: number;
  /** Called after drag-resize with the new width. */
  onWidthChange?: (width: number) => void;
  minWidth?: number;
  maxWidth?: number;
  ref?: Ref<HTMLElement>;
}

const ROOT_BASE_CLASSES = [
  "flex flex-col",
  "bg-[var(--surface-overlay)]",
  "text-[color:var(--content-default)]",
  "overflow-hidden",
].join(" ");

/* The 1px border is desktop-card chrome: the rail floats on the page
 * background, so it needs an edge. The full-bleed mobile overlay is a
 * full-screen sheet — a border there draws visible hairlines along the
 * screen edges (top/bottom safe-area boundaries on iOS). */
const ROOT_RAIL_BORDER_CLASSES = "border border-[var(--border-base)]";

/* 8px of horizontal inset, the same the collapsed rail carries, so the moat
 * around the content does not change width when the rail is toggled.
 *
 * The rail's own children are cards and pills that carry their own padding, so
 * anything wider here is a second inset stacked on the first: it costs the
 * cards title width on a 220px to 400px column and pushes their edges away
 * from the resize handle, which sits at the rail's edge and reads as belonging
 * to something else. Vertical padding is unrelated and stays as it is. */
const ROOT_RAIL_PADDING = "pt-4 px-2 pb-2";

const ROOT_RAIL_EXPANDED_CLASSES = [
  ROOT_RAIL_BORDER_CLASSES,
  "w-[230px]",
  "rounded-[12px]",
  ROOT_RAIL_PADDING,
].join(" ");

/* One tile wide, sized as content so the rail's padding and border add
 * themselves: the tile then fills the column exactly, whatever chrome the
 * caller leaves on. A width that assumes chrome the caller has turned off is
 * surplus room the tile centres in, which moves every glyph inward on
 * collapse. */
const ROOT_RAIL_COLLAPSED_CLASSES = [
  ROOT_RAIL_BORDER_CLASSES,
  "box-content w-[var(--side-menu-tile-size)]",
  "rounded-[12px]",
  "pt-4 px-[var(--side-menu-collapsed-inset)] pb-2",
].join(" ");

const ROOT_RAIL_RESIZABLE_CLASSES = [
  ROOT_RAIL_BORDER_CLASSES,
  "rounded-[12px]",
  ROOT_RAIL_PADDING,
].join(" ");

/**
 * The overlay paints no surface of its own. Its host owns one, and that
 * surface is translucent on the chat side, so a second fill here would
 * compose with it and close the gap the design opens onto the page beneath.
 */
const ROOT_OVERLAY_CLASSES = [
  "w-full",
  "rounded-none",
  "p-[var(--side-menu-inset)]",
  "bg-transparent",
].join(" ");

const RAIL_TRANSITION_MS = 150;
const ROOT_RAIL_TRANSITION =
  "transition-[width,padding] duration-[150ms] ease-in-out";

function rootChromeClasses(
  variant: SideMenuVariant,
  collapsed: boolean,
  resizable: boolean,
): string {
  if (variant === "overlay") return ROOT_OVERLAY_CLASSES;
  if (collapsed) return cn(ROOT_RAIL_COLLAPSED_CLASSES, ROOT_RAIL_TRANSITION);
  const rail = resizable
    ? ROOT_RAIL_RESIZABLE_CLASSES
    : ROOT_RAIL_EXPANDED_CLASSES;
  return cn(rail, ROOT_RAIL_TRANSITION);
}

function SideMenuRoot({
  ariaLabel,
  collapsed = false,
  variant = "rail",
  width,
  onWidthChange,
  minWidth = SIDE_MENU_MIN_WIDTH,
  maxWidth = SIDE_MENU_MAX_WIDTH,
  className,
  children,
  ref,
  style,
  ...rest
}: SideMenuProps) {
  const effectiveCollapsed = variant === "overlay" ? false : collapsed;
  const resizable = variant === "rail" && onWidthChange != null;
  const showResizeHandle = resizable && !effectiveCollapsed && width != null;

  const [contentCollapsed, setContentCollapsed] = useState(effectiveCollapsed);
  if (!effectiveCollapsed && contentCollapsed) {
    setContentCollapsed(false);
  }
  useEffect(() => {
    if (!effectiveCollapsed) return;
    const id = setTimeout(() => setContentCollapsed(true), RAIL_TRANSITION_MS);
    return () => clearTimeout(id);
  }, [effectiveCollapsed]);

  // `width` is required for the handle, not just for the inline style: the
  // separator publishes it as `aria-valuenow`, and a handle that cannot say
  // where it sits is the kind of half-kept ARIA promise the pattern exists to
  // avoid. A rail sized purely by CSS gets no drag handle.
  const navRef = useRef<HTMLElement>(null);
  const { handleProps, isResizing, paneId } = useResizablePane({
    side: "start",
    defaultSize: width ?? minWidth,
    minSize: minWidth,
    maxSize: maxWidth,
    label: "Resize sidebar",
    paneId: rest.id,
    paneRef: navRef,
    onSizeCommit: onWidthChange,
  });

  const geometryVars = variant === "overlay" ? OVERLAY_VARS : RAIL_GEOMETRY_VARS;
  const widthStyle =
    resizable && !effectiveCollapsed && width != null
      ? { ...geometryVars, ...style, width }
      : { ...geometryVars, ...style };

  return (
    <SideMenuContext
      value={{ collapsed: effectiveCollapsed, contentCollapsed, variant }}
    >
      <nav
        ref={(node) => {
          navRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        data-slot="side-menu"
        role="navigation"
        aria-label={ariaLabel}
        className={cn(
          ROOT_BASE_CLASSES,
          showResizeHandle && "relative",
          rootChromeClasses(variant, effectiveCollapsed, resizable),
          // The rail animates its width when collapsing. During a drag that
          // easing would make the edge lag the cursor, so it is suspended for
          // the drag's duration. It must come after `rootChromeClasses`, whose
          // `transition-[width,padding]` is in the same tailwind-merge group
          // and wins when it is last.
          isResizing && "transition-none",
          className,
        )}
        style={widthStyle}
        {...rest}
        id={paneId}
      >
        {children}
        {showResizeHandle ? (
          <PaneResizeHandle
            {...handleProps}
            className="absolute right-0 top-0 bottom-0 z-10 w-[6px] group/resize"
          >
            <div className="pointer-events-none absolute right-0 top-2 bottom-2 w-[2px] rounded-full bg-[var(--content-tertiary)] opacity-0 transition-opacity group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100" />
          </PaneResizeHandle>
        ) : null}
      </nav>
    </SideMenuContext>
  );
}

// ---------------------------------------------------------------------------
// Header / Body / Footer
// ---------------------------------------------------------------------------

interface SlotProps extends ComponentProps<"div"> {
  ref?: Ref<HTMLDivElement>;
}

function SideMenuHeader({ className, children, ref, ...rest }: SlotProps) {
  return (
    <div
      ref={ref}
      data-slot="side-menu-header"
      className={cn("flex flex-col gap-2", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

function SideMenuBody({ className, children, ref, ...rest }: SlotProps) {
  return (
    <div
      ref={ref}
      data-slot="side-menu-body"
      className={cn(
        "flex flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

function SideMenuFooter({ className, children, ref, ...rest }: SlotProps) {
  return (
    <div
      ref={ref}
      data-slot="side-menu-footer"
      className={cn("mt-auto flex flex-col gap-2 pt-2", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

function SideMenuSeparator({
  className,
  ref,
  ...rest
}: ComponentProps<"hr"> & { ref?: Ref<HTMLHRElement> }) {
  return (
    <hr
      ref={ref}
      data-slot="side-menu-separator"
      className={cn(
        "my-1 h-px w-full border-0 bg-[var(--border-base)]",
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// SectionHeader: the title row of a group of rows
// ---------------------------------------------------------------------------

interface SideMenuSectionHeaderOwnProps extends ComponentProps<"div"> {
  asChild?: false;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Render the caller's own element instead, typically a disclosure trigger,
 * with this row's geometry merged onto it. The child is the rendered element,
 * so a ref lands on whatever the caller chose rather than on a `div`.
 */
interface SideMenuSectionHeaderSlotProps extends Omit<
  ComponentProps<"div">,
  "children" | "ref"
> {
  asChild: true;
  children: ReactElement;
  ref?: Ref<HTMLElement>;
}

export type SideMenuSectionHeaderProps =
  SideMenuSectionHeaderOwnProps | SideMenuSectionHeaderSlotProps;

/**
 * The title row of a group in the rail. It is a top-level row like a pill or a
 * tile, so it stands at the same height, taken from the property
 * {@link SideMenuRoot} publishes ({@link SIDE_MENU_TILE_SIZE}); on a
 * touch-sized viewport it grows to its own padding the way every other row
 * does. It wears small caps and no resting surface, which is why it is this
 * rather than a `PanelItem`.
 *
 * Owns the vertical geometry, the part that has to agree with the rows around
 * it. Typography, horizontal insets, and whatever sits on the trailing edge
 * stay with the caller, whose sidebar decides those.
 */
function SideMenuSectionHeader(props: SideMenuSectionHeaderProps) {
  const className = cn(
    "flex shrink-0 items-center rounded-[6px]",
    "h-[var(--side-menu-tile-size)] max-md:h-auto",
    props.className,
  );
  if (props.asChild === true) {
    const {
      asChild: _asChild,
      className: _className,
      children,
      ref,
      ...rest
    } = props;
    reportUnmergeableSlotChild("SideMenu.SectionHeader", children);
    return (
      <Slot
        ref={ref}
        data-slot="side-menu-section-header"
        className={className}
        {...rest}
      >
        {children}
      </Slot>
    );
  }
  const { asChild: _asChild, className: _className, ref, ...rest } = props;
  return (
    <div
      ref={ref}
      data-slot="side-menu-section-header"
      className={className}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Section — title row + right-aligned actions
// ---------------------------------------------------------------------------

export interface SideMenuSectionProps extends ComponentProps<"div"> {
  title?: string;
  actions?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

function SideMenuSection({
  title,
  actions,
  className,
  children,
  ref,
  ...rest
}: SideMenuSectionProps) {
  const ctx = useSideMenuContext();
  const hideHeader = isCollapsedRail(ctx);
  return (
    <div
      ref={ref}
      data-slot="side-menu-section"
      className={cn("flex flex-col gap-2", className)}
      {...rest}
    >
      {!hideHeader && (title || actions) ? (
        <div className="flex h-[30px] items-center justify-between px-[6px]">
          {title ? (
            <Typography
              variant="body-medium-default"
              as="span"
              className="text-[color:var(--content-tertiary)]"
            >
              {title}
            </Typography>
          ) : (
            <span />
          )}
          {actions ? (
            <div className="flex items-center gap-[4px]">{actions}</div>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SubList — suppressed in collapsed rail mode
// ---------------------------------------------------------------------------

function SideMenuSubList({
  className,
  children,
  ref,
  ...rest
}: ComponentProps<"ul"> & { ref?: Ref<HTMLUListElement> }) {
  const ctx = useSideMenuContext();
  if (isCollapsedRail(ctx)) return null;
  return (
    <ul
      ref={ref}
      data-slot="side-menu-sub-list"
      className={cn("flex flex-col gap-[4px] list-none p-0 m-0", className)}
      {...rest}
    >
      {children}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

/**
 * Leading icon for a SideMenu.Item.
 *
 * Polymorphic by design: most call sites pass a Lucide component (`Globe`,
 * `Rocket`, …), but app-shaped surfaces (pinned apps, library entries) carry
 * an emoji string on their record (`app.icon: "🚀"`) sourced from the app
 * manifest. Accepting either keeps the prop name consistent end-to-end with
 * the underlying field and lets callers express the fallback inline:
 * `icon={app.icon ?? Rocket}`.
 */
export type SideMenuItemIcon = LucideIcon | string;

export interface SideMenuItemProps {
  icon?: SideMenuItemIcon;
  label: string;
  /**
   * Show a styled tooltip on hover in the collapsed rail, defaulting its
   * content to `label` (the common case where the tooltip just surfaces the
   * hidden label). Ignored when expanded, since the label is already visible.
   * Use `tooltip` instead when the text should differ from `label`.
   */
  showCollapsedTooltip?: boolean;
  /**
   * Custom collapsed-rail tooltip text, for when it should differ from
   * `label`. Implies `showCollapsedTooltip` and replaces the native `title`.
   * Ignored when expanded. Mirrors the `tooltip` prop on `Button`.
   */
  tooltip?: string;
  badge?: ReactNode;
  /**
   * `"tile"` renders the collapsed-rail affordance: the whole treatment a row
   * reduces to when the rail collapses, not a geometry switch. It squares to
   * the pill height ({@link SIDE_MENU_TILE_SIZE}, which a row carrying this
   * shape also sets itself to), centers in the rail column, rounds fully, and
   * carries the resting surface the expanded card or pill wore: collapsing
   * changes the shape of a thing, not whether it has a surface. The squaring
   * is part of it, not an extra: a collapsed row is `w-full` of a column
   * slightly wider than it is tall, so rounding it alone draws an ellipse.
   *
   * Named for what it is rather than for its outline, because it decides
   * colour as well as form. A caller reaching for a round row somewhere other
   * than the rail wants neither.
   *
   * Its surface reads the same `--panel-item-bg` / `--panel-item-hover` /
   * `--panel-item-active` properties `PanelItem`'s pill does, each falling
   * back to the untinted token. So a caller that tints the expanded pill tints
   * the collapsed tile with the same one declaration, and a caller that tints
   * nothing sees no difference.
   *
   * Ignored when expanded, where the row spans the rail's full width and a
   * full round would draw a pill rather than a circle.
   *
   * @default "default"
   */
  shape?: "default" | "tile";
  /**
   * Overlay drawn on top of a collapsed tile, such as an activity dot on the
   * icon's corner. The row is the positioning context, so the caller places
   * it (`absolute right-0 top-0`).
   *
   * Ignored when expanded: a row with its label visible carries status
   * inline through `badge` instead of overlapping its own icon.
   */
  indicator?: ReactNode;
  /**
   * Nothing to open. Blocks activation, drops the row from the tab order,
   * and mutes it, matching what native `disabled` would do.
   *
   * It is expressed as `aria-disabled` rather than the native attribute
   * because a collapsed row is its own tooltip trigger, and a natively
   * disabled control dispatches no pointer events: the tooltip explaining
   * *why* the row does nothing would be the one thing a user could not
   * reach. The native attribute is omitted from this component's props for
   * the same reason.
   */
  disabled?: boolean;
  trailingIcon?: LucideIcon;
  trailingIconClassName?: string;
  indent?: boolean;
  active?: boolean;
  emphasized?: boolean;
  size?: "default" | "compact";
  onSelect?: () => void;
  href?: string;
  className?: string;
  ref?: Ref<HTMLAnchorElement | HTMLButtonElement>;
}

function ItemLeadingIcon({
  icon,
  indent,
  active,
  collapsed,
  disabled,
}: {
  icon: SideMenuItemIcon | undefined;
  indent: boolean;
  active: boolean;
  collapsed: boolean;
  disabled: boolean;
}) {
  if (indent) {
    return (
      <span aria-hidden className="inline-block h-[14px] w-[14px] shrink-0" />
    );
  }
  if (!icon) return null;
  // String icons (emoji) render in a fixed-size span sized to match the 14px
  // Lucide icons so layout stays uniform whether the row is a Lucide-backed
  // nav entry or an app row pulling an emoji from its manifest.
  if (typeof icon === "string") {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center text-[14px] leading-none",
          collapsed ? "mx-auto" : undefined,
        )}
      >
        {icon}
      </span>
    );
  }
  const Icon = icon;
  const iconClass = cn(
    "shrink-0",
    disabled
      ? "text-[color:var(--content-disabled)]"
      : active
        ? "text-[color:var(--content-default)]"
        : "text-[color:var(--content-tertiary)]",
    collapsed ? "mx-auto" : undefined,
  );
  return <Icon size={14} aria-hidden className={iconClass} />;
}

function ItemBadge({ children }: { children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center",
        "px-[4px] py-[2px] rounded-[4px]",
        "bg-[var(--surface-base)]",
        "text-label-small-default",
        "text-[color:var(--content-tertiary)]",
      )}
    >
      {children}
    </span>
  );
}

type SharedAnchorProps = Omit<ComponentProps<"a">, "href" | "children" | "ref">;
/* `disabled` is omitted so the component's own `aria-disabled` treatment is
 * the only way to express the state: a native `disabled` button dispatches
 * no pointer events, which would silence the collapsed row's tooltip. */
type SharedButtonProps = Omit<
  ComponentProps<"button">,
  "children" | "type" | "ref" | "disabled"
>;

function SideMenuItem({
  icon,
  label,
  showCollapsedTooltip = false,
  tooltip,
  badge,
  shape = "default",
  indicator,
  disabled = false,
  trailingIcon: TrailingIcon,
  trailingIconClassName,
  indent = false,
  active = false,
  emphasized = false,
  size = "default",
  onSelect,
  href,
  className,
  tabIndex,
  ref,
  ...rest
}: SideMenuItemProps & SharedAnchorProps & SharedButtonProps) {
  const ctx = useSideMenuContext();
  /* A tile is a collapsed-rail affordance by definition, and its call
     sites mount it on the rail's immediate `collapsed` state. Following the
     delayed flag like an ordinary row would leave it rendering as a
     full-width labelled row inside the 48px column for the whole 150ms
     transition, with no dot, tooltip, or accessible name. It also has no
     label to linger over, which is the only thing the delay buys. Keying it
     off the immediate flag flips every collapsed-only path at one instant. */
  const collapsed =
    shape === "tile" ? isCollapsingRail(ctx) : isCollapsedRail(ctx);

  /* An item is drawn either as a row or as a tile, and the two want opposite
     things, so they are alternatives rather than one layered over the other.
     A row fills the rail and grows on narrow viewports, because it carries a
     label and wants a comfortable touch target for it. A tile is a fixed
     square at the row height, with no label to make room for.

     Appending a tile-shaped patch after the row classes renders the same,
     but each of `w-full`, `rounded-[6px]`, `max-md:h-auto` and `max-md:py-3`
     then needs its own counter-class, which leaves the geometry resting on
     tailwind-merge order rather than on intent. Branching states each shape
     once, so there is nothing to counter. */
  const isTile = collapsed && shape === "tile";
  const geometryClasses = isTile
    ? /* The tile carries the same resting surface as the card or pill it
         stands in for when the rail is expanded, so collapsing changes the
         shape of a thing and not whether it has a surface at all.

         Which is why it reads the same tint properties `PanelItem`'s pill
         does, through the same fallback: a caller that tints the expanded pill
         tints this with one declaration, and one that tints nothing reaches
         `--surface-lift`. */
      "size-[var(--side-menu-tile-size)] mx-auto rounded-full bg-[var(--panel-item-bg,var(--surface-lift))]"
    : // `w-full` matters for the `<button>` render path: buttons keep
      // fit-content sizing even as flex containers, so without it a
      // button-backed item shrink-wraps while anchor-backed items fill the rail.
      "h-[30px] w-full max-md:h-auto rounded-[6px]";

  /* Interaction state, as one exclusive choice for the same reason as the
     geometry above. A disabled row keeps its slot and its hover target, since
     reaching its tooltip is the whole point of the state, and drops only the
     affordances. Expressing that by appending `cursor-default` and
     `hover:bg-transparent` after the enabled rules renders identically but
     leaves the muting dependent on tailwind-merge order; not emitting the
     rules it replaces means there is nothing to be ordered against. */
  const stateClasses = disabled
    ? "cursor-default text-[color:var(--content-disabled)]"
    : active
      ? cn(
          "cursor-pointer text-[color:var(--content-emphasised)]",
          /* A tinted tile stays tinted while it is the current page. Without
             reading the tint here, this rule and the resting one are different
             declarations of the same property, the active one wins, and the
             tile drops its colour at exactly the moment it is selected. Only
             the tile, because it is the only shape carrying a surface to
             tint. Untinted callers reach `--surface-active`. */
          isTile
            ? "bg-[var(--panel-item-active,var(--panel-item-bg,var(--surface-active)))]"
            : "bg-[var(--surface-active)]",
        )
      : cn(
          "cursor-pointer",
          /* Which hover surface is right depends on what the shape rests on.
             A tile rests on `--surface-lift`, and `--surface-hover` is a 6%
             translucent overlay meant for a transparent base - over a lifted
             surface it composites *darker* than the resting state, so the
             tile reads as having no hover at all. `--surface-active` is the
             step up from lifted. A row rests transparent, where the overlay
             is exactly what it was built for. */
          isTile
            ? "hover:bg-[var(--panel-item-hover,var(--surface-active))]"
            : "hover:bg-[var(--surface-hover)]",
          emphasized
            ? "text-[color:var(--content-emphasised)]"
            : "text-[color:var(--content-secondary)]",
        );

  const rowClasses = cn(
    "group relative flex items-center",
    geometryClasses,
    "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
    "select-none",
    "transition-colors",
    "gap-[6px] p-[6px]",
    collapsed ? "justify-center" : "justify-start",
    size === "compact"
      ? "text-body-small-default max-md:text-body-large-default"
      : cn(
          "text-body-medium-lighter max-md:text-body-large-default",
          // Vertical breathing room for a wrapped label on a narrow viewport.
          // A tile has no label, and the fixed square is the whole point.
          !isTile && "max-md:py-3",
        ),
    stateClasses,
    className,
  );

  const labelNode = collapsed ? null : (
    <span className="min-w-0 flex-1 truncate text-left text-optical-center">
      {label}
    </span>
  );
  const badgeNode = collapsed || !badge ? null : <ItemBadge>{badge}</ItemBadge>;
  const trailingNode =
    collapsed || !TrailingIcon ? null : (
      <TrailingIcon
        size={14}
        aria-hidden
        className={cn(
          "shrink-0 text-[color:var(--content-tertiary)]",
          trailingIconClassName,
        )}
      />
    );

  const leadingIconNode = (
    <ItemLeadingIcon
      icon={icon}
      indent={indent}
      active={active}
      collapsed={collapsed}
      disabled={disabled}
    />
  );

  const indicatorNode = collapsed ? indicator : null;

  // Collapsed rail shows a styled tooltip when asked (defaulting to `label`)
  // or when custom `tooltip` text is given. Drop the native `title` then so the
  // two don't stack into a double tooltip on hover.
  const tooltipContent = tooltip ?? (showCollapsedTooltip ? label : undefined);
  const showStyledTooltip = collapsed && tooltipContent != null;
  const titleAttr = collapsed && !showStyledTooltip ? label : undefined;
  const ariaCurrent = active ? ("page" as const) : undefined;
  /* Collapsed, the label is not rendered and the leading icon is aria-hidden,
     so without this the row has no accessible name at all on the styled-
     tooltip path (a `title` names it on the other one). Placed before the
     prop spread below so a caller can still override it, which the rail's
     empty sections do: their tooltip explains the empty state while the name
     stays the section's. */
  const collapsedAriaLabel = collapsed ? label : undefined;

  const withTooltip = (element: ReactNode) =>
    showStyledTooltip ? (
      <Tooltip content={tooltipContent} side="right">
        {element}
      </Tooltip>
    ) : (
      element
    );

  if (href) {
    const { onClick: anchorOnClick, ...anchorProps } =
      rest as SharedAnchorProps;
    return withTooltip(
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        data-slot="side-menu-item"
        href={disabled ? undefined : href}
        title={titleAttr}
        aria-current={ariaCurrent}
        aria-label={collapsedAriaLabel}
        className={rowClasses}
        onClick={(event) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          anchorOnClick?.(event);
          if (!event.defaultPrevented) {
            onSelect?.();
          }
        }}
        {...anchorProps}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : tabIndex}
      >
        {leadingIconNode}
        {labelNode}
        {badgeNode}
        {trailingNode}
        {indicatorNode}
      </a>,
    );
  }

  const {
    onClick: buttonOnClick,
    onKeyDown: buttonOnKeyDown,
    ...buttonProps
  } = rest as SharedButtonProps;

  const composedOnClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    buttonOnClick?.(event);
    if (!event.defaultPrevented) {
      onSelect?.();
    }
  };

  return withTooltip(
    <button
      ref={ref as Ref<HTMLButtonElement>}
      data-slot="side-menu-item"
      type="button"
      title={titleAttr}
      aria-current={ariaCurrent}
      aria-label={collapsedAriaLabel}
      className={rowClasses}
      onClick={composedOnClick}
      onKeyDown={buttonOnKeyDown}
      {...buttonProps}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : tabIndex}
    >
      {leadingIconNode}
      {labelNode}
      {badgeNode}
      {trailingNode}
      {indicatorNode}
    </button>,
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

type SideMenuComponent = typeof SideMenuRoot & {
  Header: typeof SideMenuHeader;
  Body: typeof SideMenuBody;
  Footer: typeof SideMenuFooter;
  Section: typeof SideMenuSection;
  SectionHeader: typeof SideMenuSectionHeader;
  SubList: typeof SideMenuSubList;
  Item: typeof SideMenuItem;
  Separator: typeof SideMenuSeparator;
};

const SideMenu = SideMenuRoot as SideMenuComponent;
SideMenu.Header = SideMenuHeader;
SideMenu.Body = SideMenuBody;
SideMenu.Footer = SideMenuFooter;
SideMenu.Section = SideMenuSection;
SideMenu.SectionHeader = SideMenuSectionHeader;
SideMenu.SubList = SideMenuSubList;
SideMenu.Item = SideMenuItem;
SideMenu.Separator = SideMenuSeparator;

export {
  SideMenu,
  SideMenuBody,
  SideMenuFooter,
  SideMenuHeader,
  SideMenuItem,
  SideMenuSection,
  SideMenuSectionHeader,
  SideMenuSeparator,
  SideMenuSubList,
  useSideMenuCollapsed,
};

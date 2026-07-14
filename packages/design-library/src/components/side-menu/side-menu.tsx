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
  type PointerEvent,
  type ReactNode,
  type Ref,
} from "react";

import { Typography } from "../typography";
import { Tooltip } from "../tooltip";
import { cn } from "../../utils/cn";

/**
 * SideMenu primitive — a docked application navigation rail.
 *
 * Two variants:
 * - `rail` (default) — desktop, docked left. Supports a `collapsed` state
 *   that shrinks the rail to an icon-only 48 px column. When collapsed,
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

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const SIDE_MENU_DEFAULT_WIDTH = 230;
export const SIDE_MENU_COLLAPSED_WIDTH = 48;
export const SIDE_MENU_MIN_WIDTH = 220;
export const SIDE_MENU_MAX_WIDTH = 400;

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

const ROOT_RAIL_EXPANDED_CLASSES = [
  ROOT_RAIL_BORDER_CLASSES,
  "w-[230px]",
  "rounded-[12px]",
  "pt-4 px-4 pb-2",
].join(" ");

const ROOT_RAIL_COLLAPSED_CLASSES = [
  ROOT_RAIL_BORDER_CLASSES,
  "w-[48px]",
  "rounded-[12px]",
  "pt-4 px-2 pb-2",
].join(" ");

const ROOT_RAIL_RESIZABLE_CLASSES = [
  ROOT_RAIL_BORDER_CLASSES,
  "rounded-[12px]",
  "pt-4 px-4 pb-2",
].join(" ");

const ROOT_OVERLAY_CLASSES = [
  "w-full",
  "rounded-none",
  "p-4",
].join(" ");

const RAIL_TRANSITION_MS = 150;
const ROOT_RAIL_TRANSITION = "transition-[width,padding] duration-[150ms] ease-in-out";

function rootChromeClasses(variant: SideMenuVariant, collapsed: boolean, resizable: boolean): string {
  if (variant === "overlay") return ROOT_OVERLAY_CLASSES;
  if (collapsed) return cn(ROOT_RAIL_COLLAPSED_CLASSES, ROOT_RAIL_TRANSITION);
  const rail = resizable ? ROOT_RAIL_RESIZABLE_CLASSES : ROOT_RAIL_EXPANDED_CLASSES;
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
  const showResizeHandle = resizable && !effectiveCollapsed;

  const [contentCollapsed, setContentCollapsed] = useState(effectiveCollapsed);
  if (!effectiveCollapsed && contentCollapsed) {
    setContentCollapsed(false);
  }
  useEffect(() => {
    if (!effectiveCollapsed) return;
    const id = setTimeout(() => setContentCollapsed(true), RAIL_TRANSITION_MS);
    return () => clearTimeout(id);
  }, [effectiveCollapsed]);

  const dragRef = useRef<{
    nav: HTMLElement;
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleResizePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!onWidthChange) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const nav = e.currentTarget.closest(
        '[data-slot="side-menu"]',
      ) as HTMLElement | null;
      if (!nav) return;
      dragRef.current = {
        nav,
        startX: e.clientX,
        startWidth: nav.getBoundingClientRect().width,
      };
      nav.style.transition = "none";
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onWidthChange],
  );

  const handleResizePointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = e.clientX - drag.startX;
      const next = Math.min(maxWidth, Math.max(minWidth, drag.startWidth + delta));
      drag.nav.style.width = `${next}px`;
    },
    [minWidth, maxWidth],
  );

  const handleResizeEnd = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      dragRef.current = null;
      drag.nav.style.transition = "";
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const delta = e.clientX - drag.startX;
      const finalWidth = Math.min(maxWidth, Math.max(minWidth, drag.startWidth + delta));
      onWidthChange?.(finalWidth);
    },
    [onWidthChange, minWidth, maxWidth],
  );

  useEffect(() => {
    return () => {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, []);

  const widthStyle =
    resizable && !effectiveCollapsed && width != null
      ? { ...style, width }
      : style;

  return (
    <SideMenuContext
      value={{ collapsed: effectiveCollapsed, contentCollapsed, variant }}
    >
      <nav
        ref={ref}
        data-slot="side-menu"
        role="navigation"
        aria-label={ariaLabel}
        className={cn(
          ROOT_BASE_CLASSES,
          showResizeHandle && "relative",
          rootChromeClasses(variant, effectiveCollapsed, resizable),
          className,
        )}
        style={widthStyle}
        {...rest}
      >
        {children}
        {showResizeHandle ? (
          <div
            role="separator"
            aria-orientation="vertical"
            className="absolute right-0 top-0 bottom-0 z-10 w-[6px] cursor-col-resize group/resize"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
          >
            <div className="pointer-events-none absolute right-0 top-2 bottom-2 w-[2px] rounded-full bg-[var(--content-tertiary)] opacity-0 transition-opacity group-hover/resize:opacity-100" />
          </div>
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
}: {
  icon: SideMenuItemIcon | undefined;
  indent: boolean;
  active: boolean;
  collapsed: boolean;
}) {
  if (indent) {
    return (
      <span
        aria-hidden
        className="inline-block h-[14px] w-[14px] shrink-0"
      />
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
    active
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

type SharedAnchorProps = Omit<
  ComponentProps<"a">,
  "href" | "children" | "ref"
>;
type SharedButtonProps = Omit<
  ComponentProps<"button">,
  "children" | "type" | "ref"
>;

function SideMenuItem({
  icon,
  label,
  showCollapsedTooltip = false,
  tooltip,
  badge,
  trailingIcon: TrailingIcon,
  trailingIconClassName,
  indent = false,
  active = false,
  emphasized = false,
  size = "default",
  onSelect,
  href,
  className,
  ref,
  ...rest
}: SideMenuItemProps & SharedAnchorProps & SharedButtonProps) {
  const ctx = useSideMenuContext();
  const collapsed = isCollapsedRail(ctx);

  const rowClasses = cn(
    "group relative flex items-center",
    "rounded-[6px]",
    "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
    "cursor-pointer select-none",
    "transition-colors",
    "h-[30px] max-md:h-auto gap-[6px] p-[6px]",
    collapsed ? "justify-center" : "justify-start",
    size === "compact"
      ? "text-body-small-default max-md:text-body-large-default"
      : "text-body-medium-lighter max-md:py-3 max-md:text-body-large-default",
    emphasized
      ? "text-[color:var(--content-emphasised)]"
      : "text-[color:var(--content-secondary)]",
    active
      ? "bg-[var(--surface-active)] text-[color:var(--content-emphasised)]"
      : "hover:bg-[var(--surface-hover)]",
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
    />
  );

  // Collapsed rail shows a styled tooltip when asked (defaulting to `label`)
  // or when custom `tooltip` text is given. Drop the native `title` then so the
  // two don't stack into a double tooltip on hover.
  const tooltipContent = tooltip ?? (showCollapsedTooltip ? label : undefined);
  const showStyledTooltip = collapsed && tooltipContent != null;
  const titleAttr = collapsed && !showStyledTooltip ? label : undefined;
  const ariaCurrent = active ? ("page" as const) : undefined;

  const withTooltip = (element: ReactNode) =>
    showStyledTooltip ? (
      <Tooltip content={tooltipContent} side="right">
        {element}
      </Tooltip>
    ) : (
      element
    );

  if (href) {
    const {
      onClick: anchorOnClick,
      ...anchorProps
    } = rest as SharedAnchorProps;
    return withTooltip(
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        data-slot="side-menu-item"
        href={href}
        title={titleAttr}
        aria-current={ariaCurrent}
        className={rowClasses}
        onClick={(event) => {
          anchorOnClick?.(event);
          if (!event.defaultPrevented) {
            onSelect?.();
          }
        }}
        {...anchorProps}
      >
        {leadingIconNode}
        {labelNode}
        {badgeNode}
        {trailingNode}
      </a>
    );
  }

  const {
    onClick: buttonOnClick,
    onKeyDown: buttonOnKeyDown,
    ...buttonProps
  } = rest as SharedButtonProps;

  const composedOnClick = (event: MouseEvent<HTMLButtonElement>) => {
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
      className={rowClasses}
      onClick={composedOnClick}
      onKeyDown={buttonOnKeyDown}
      {...buttonProps}
    >
      {leadingIconNode}
      {labelNode}
      {badgeNode}
      {trailingNode}
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
  SubList: typeof SideMenuSubList;
  Item: typeof SideMenuItem;
  Separator: typeof SideMenuSeparator;
};

const SideMenu = SideMenuRoot as SideMenuComponent;
SideMenu.Header = SideMenuHeader;
SideMenu.Body = SideMenuBody;
SideMenu.Footer = SideMenuFooter;
SideMenu.Section = SideMenuSection;
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
  SideMenuSeparator,
  SideMenuSubList,
};

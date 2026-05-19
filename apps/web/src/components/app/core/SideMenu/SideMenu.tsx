
import type { LucideIcon } from "lucide-react";
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

import { Typography } from "@vellum/design-library/components/typography";
import { cn } from "@vellum/design-library/utils/cn";

/**
 * SideMenu primitive — a docked application navigation rail.
 *
 * Two variants:
 * - `rail` (default) — desktop, docked left. Supports a `collapsed` state
 *   that shrinks the rail to an icon-only `48px` column. When collapsed,
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
 * All colors come from semantic tokens declared in
 * `src/app/(app)/appTheme.css`. Zero hex literals live in this file.
 */

// ---------------------------------------------------------------------------
// Context — consumers never conditionally render child content; subcomponents
// read variant + collapsed from context and hide themselves as needed.
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
// Root — <nav> landmark with rail/overlay chrome
// ---------------------------------------------------------------------------

export interface SideMenuProps extends HTMLAttributes<HTMLElement> {
  /** Ignored when `variant="overlay"`. */
  collapsed?: boolean;
  /** `rail` = desktop docked; `overlay` = mobile full-bleed. */
  variant?: SideMenuVariant;
  /** Required for the `navigation` landmark role. */
  ariaLabel: string;
  children?: ReactNode;
  className?: string;
}

const ROOT_BASE_CLASSES = [
  "flex flex-col",
  "bg-[var(--surface-overlay)]",
  "text-[color:var(--content-default)]",
  "border border-[var(--border-base)]",
  "overflow-hidden",
].join(" ");

const ROOT_RAIL_EXPANDED_CLASSES = [
  "w-[230px]",
  "rounded-[12px]",
  "pt-4 px-4 pb-2",
].join(" ");

const ROOT_RAIL_COLLAPSED_CLASSES = [
  "w-[48px]",
  "rounded-[12px]",
  "pt-4 px-2 pb-2",
].join(" ");

const ROOT_OVERLAY_CLASSES = [
  "w-full",
  // Square corners — the overlay covers the full viewport (status bar
  // through home indicator), so the surface bleeds to the device's own
  // rounded screen edges and any radius here would just look inset.
  "rounded-none",
  // 16px padding all around — items render full-width within the padded
  // box (iOS-style grouped list card), with their own internal padding
  // for icon/label spacing.
  "p-4",
].join(" ");

const RAIL_TRANSITION_MS = 150;
const ROOT_RAIL_TRANSITION = `transition-[width,padding] duration-[${RAIL_TRANSITION_MS}ms] ease-in-out`;

function rootChromeClasses(variant: SideMenuVariant, collapsed: boolean): string {
  if (variant === "overlay") return ROOT_OVERLAY_CLASSES;
  const rail = collapsed ? ROOT_RAIL_COLLAPSED_CLASSES : ROOT_RAIL_EXPANDED_CLASSES;
  return `${rail} ${ROOT_RAIL_TRANSITION}`;
}

const SideMenuRoot = forwardRef<HTMLElement, SideMenuProps>(function SideMenu(
  {
    ariaLabel,
    collapsed = false,
    variant = "rail",
    className,
    children,
    ...rest
  },
  ref,
) {
  // Overlay variant always renders labels regardless of `collapsed` — mirror
  // that in the context so subcomponents don't need to special-case.
  const effectiveCollapsed = variant === "overlay" ? false : collapsed;

  // Content visibility lags behind when collapsing: show content immediately
  // on expand, but delay hiding it until the width transition finishes.
  const [contentCollapsed, setContentCollapsed] = useState(effectiveCollapsed);
  if (!effectiveCollapsed && contentCollapsed) {
    setContentCollapsed(false);
  }
  useEffect(() => {
    if (!effectiveCollapsed) return;
    const id = setTimeout(() => setContentCollapsed(true), RAIL_TRANSITION_MS);
    return () => clearTimeout(id);
  }, [effectiveCollapsed]);

  return (
    <SideMenuContext
      value={{ collapsed: effectiveCollapsed, contentCollapsed, variant }}
    >
      <nav
        ref={ref}
        role="navigation"
        aria-label={ariaLabel}
        className={cn(
          ROOT_BASE_CLASSES,
          rootChromeClasses(variant, effectiveCollapsed),
          className,
        )}
        {...rest}
      >
        {children}
      </nav>
    </SideMenuContext>
  );
});

// ---------------------------------------------------------------------------
// Header / Body / Footer slots
// ---------------------------------------------------------------------------

interface SlotProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

const SideMenuHeader = forwardRef<HTMLDivElement, SlotProps>(
  function SideMenuHeader({ className, children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn("flex flex-col gap-2", className)}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

const SideMenuBody = forwardRef<HTMLDivElement, SlotProps>(
  function SideMenuBody({ className, children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "flex flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden",
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

const SideMenuFooter = forwardRef<HTMLDivElement, SlotProps>(
  function SideMenuFooter({ className, children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn("mt-auto flex flex-col gap-2 pt-2", className)}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Separator — 1px full-width rule
// ---------------------------------------------------------------------------

type SeparatorProps = HTMLAttributes<HTMLHRElement>;

const SideMenuSeparator = forwardRef<HTMLHRElement, SeparatorProps>(
  function SideMenuSeparator({ className, ...rest }, ref) {
    return (
      <hr
        ref={ref}
        className={cn(
          "my-1 h-px w-full border-0 bg-[var(--border-base)]",
          className,
        )}
        {...rest}
      />
    );
  },
);

// ---------------------------------------------------------------------------
// Section — title row + right-aligned actions. Title + actions suppressed in
// collapsed rail mode; children always render.
// ---------------------------------------------------------------------------

export interface SideMenuSectionProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

const SideMenuSection = forwardRef<HTMLDivElement, SideMenuSectionProps>(
  function SideMenuSection(
    { title, actions, className, children, ...rest },
    ref,
  ) {
    const ctx = useSideMenuContext();
    const hideHeader = isCollapsedRail(ctx);
    return (
      <div
        ref={ref}
        className={cn("flex flex-col gap-2", className)}
        {...rest}
      >
        {!hideHeader && (title || actions) ? (
          <div className="flex h-[21px] items-center justify-between">
            {title ? (
              <Typography
                variant="body-small-default"
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
  },
);

// ---------------------------------------------------------------------------
// SubList — <ul> wrapper. Suppressed in collapsed rail mode.
// ---------------------------------------------------------------------------

interface SideMenuSubListProps extends HTMLAttributes<HTMLUListElement> {
  children?: ReactNode;
}

const SideMenuSubList = forwardRef<HTMLUListElement, SideMenuSubListProps>(
  function SideMenuSubList({ className, children, ...rest }, ref) {
    const ctx = useSideMenuContext();
    if (isCollapsedRail(ctx)) return null;
    return (
      <ul
        ref={ref}
        className={cn("flex flex-col gap-[2px] list-none p-0 m-0", className)}
        {...rest}
      >
        {children}
      </ul>
    );
  },
);

// ---------------------------------------------------------------------------
// Item — leading icon, label, badge, trailing icon. Supports href (renders
// <a>) or onSelect (renders <button>). Collapsed rail: hide label/badge/
// trailingIcon; center the icon; attach a native title tooltip.
// ---------------------------------------------------------------------------

export interface SideMenuItemProps {
  /** Leading icon — omit for indented thread rows. */
  icon?: LucideIcon;
  label: string;
  /** Count chip; hidden when collapsed. */
  badge?: ReactNode;
  /** e.g. a ChevronUp on expandable sections. */
  trailingIcon?: LucideIcon;
  /**
   * Extra classes merged onto the trailing icon — useful for responsive
   * visibility (e.g. `md:hidden` on a chevron that should only appear on
   * mobile menus). Has no effect when `trailingIcon` is unset.
   */
  trailingIconClassName?: string;
  /** Thread rows — reserves icon slot but hides it. */
  indent?: boolean;
  active?: boolean;
  /** Brighter text (selected thread / "Show more"). */
  emphasized?: boolean;
  /** `compact` = 12px text for the Conversations section. */
  size?: "default" | "compact";
  onSelect?: () => void;
  /** If provided, renders as `<a>` instead of `<button>`. */
  href?: string;
  className?: string;
}

/**
 * Render the leading icon slot for an `Item`. When `indent` is true we still
 * emit a placeholder span so thread-row labels sit in the same horizontal
 * position as icon'd rows (matches Figma — indented labels align with the
 * start of the label in rows above).
 */
function ItemLeadingIcon({
  Icon,
  indent,
  active,
  collapsed,
}: {
  Icon: LucideIcon | undefined;
  indent: boolean;
  active: boolean;
  collapsed: boolean;
}) {
  if (indent) {
    // Reserves the icon slot so labels align, but nothing is drawn.
    return (
      <span
        aria-hidden
        className="inline-block h-[14px] w-[14px] shrink-0"
      />
    );
  }
  if (!Icon) return null;
  const iconClass = cn(
    "shrink-0",
    active
      ? "text-[color:var(--content-emphasised)]"
      : "text-[color:var(--content-secondary)]",
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
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "children"
>;
type SharedButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "type"
>;

const SideMenuItem = forwardRef<
  HTMLAnchorElement | HTMLButtonElement,
  SideMenuItemProps & SharedAnchorProps & SharedButtonProps
>(function SideMenuItem(
  {
    icon: Icon,
    label,
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
    ...rest
  },
  ref,
) {
  const ctx = useSideMenuContext();
  const collapsed = isCollapsedRail(ctx);

  // Hover background — separate from active so both states compose cleanly.
  // `--surface-hover` is a token in appTheme.css (both light + dark blocks).
  const rowClasses = cn(
    "group relative flex items-center",
    "rounded-[6px]",
    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
    "cursor-pointer select-none",
    "transition-colors",
    "gap-[8px] p-2",
    // Justify: collapsed rail centers the icon; all other cases left-align.
    collapsed ? "justify-center" : "justify-start",
    // Text sizing — compact is 12/500 for the Conversations section; regular
    // is 14/400/18. Mobile: both bump to body-large-default (16/500/100) so
    // every side-menu row reads at the same thumb-friendly size, matching
    // `PanelItem`. Regular rows also gain 12px py for a 40px tap target.
    size === "compact"
      ? "text-body-small-default max-md:text-body-large-default"
      : "text-body-medium-lighter max-md:py-3 max-md:text-body-large-default",
    // Default text color. Emphasised overrides to a brighter token.
    emphasized
      ? "text-[color:var(--content-emphasised)]"
      : "text-[color:var(--content-secondary)]",
    // Active vs hover surfaces.
    active
      ? "bg-[var(--surface-active)] text-[color:var(--content-emphasised)]"
      : "hover:bg-[var(--surface-hover)]",
    className,
  );

  const labelNode = collapsed ? null : (
    <span className="min-w-0 flex-1 truncate text-left">{label}</span>
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
      Icon={Icon}
      indent={indent}
      active={active}
      collapsed={collapsed}
    />
  );

  // Native `title` tooltip when collapsed so users can discover labels.
  const titleAttr = collapsed ? label : undefined;

  const ariaCurrent = active ? ("page" as const) : undefined;

  if (href) {
    const anchorProps = rest as SharedAnchorProps;
    return (
      <a
        ref={ref as React.Ref<HTMLAnchorElement>}
        href={href}
        title={titleAttr}
        aria-current={ariaCurrent}
        className={rowClasses}
        onClick={(event) => {
          anchorProps.onClick?.(event);
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

  // Compose caller-provided + internal handlers explicitly. Spreading
  // `rest` after our internal `onClick` would have Radix's injected
  // `onClick` (via `Popover.Trigger asChild`) silently override our
  // `onSelect`; plucking the handlers out first lets both fire.
  const composedOnClick = (event: MouseEvent<HTMLButtonElement>) => {
    buttonOnClick?.(event);
    if (!event.defaultPrevented) {
      onSelect?.();
    }
  };

  // Native <button> synthesises click from Enter/Space, which then
  // fires our `onClick` (including onSelect). We forward the caller's
  // onKeyDown if any, but do NOT preventDefault — doing so would
  // suppress the synthesised click, breaking Radix Popover's keyboard
  // activation path when this button is used as a trigger.
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
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
    </button>
  );
});

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

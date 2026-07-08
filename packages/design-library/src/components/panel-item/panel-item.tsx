import { Slot } from "@radix-ui/react-slot";
import type { LucideIcon } from "lucide-react";
import {
  type AnchorHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../../utils/cn";

import { MarqueeText } from "./marquee-text";

/**
 * Sidepanel / navigation row primitive. One row you can drop into a sidebar,
 * settings nav, admin tree, menu, or any list where rows need the standard
 * hover / active state treatment.
 *
 * Visual spec:
 *
 * - 32px tall, `rounded-[6px]`, `p-[8px]`, `gap-[8px]` between leading icon
 *   and label.
 * - Default: transparent background, `--content-tertiary` icon,
 *   `--content-secondary` label, pill-styled `badge` on `--surface-base`.
 * - Hover (CSS `:hover`): `--surface-hover` background, icon brightens to
 *   `--content-secondary`, badge loses its pill chrome, `trailingAction`
 *   fades in.
 * - Active (controlled by the `active` prop, renders `aria-current="page"`):
 *   `--surface-active` background, icon brightens to `--content-default`,
 *   label brightens to `--content-emphasised`, badge stays pill-less,
 *   `trailingAction` stays visible.
 *
 * Label typography uses the `body-medium-lighter` token (14/400/18).
 *
 * Renders `<a href>` when `href` is provided, `<div role="button">` when
 * `onSelect` is provided (the row container hosts interactive children in
 * `leadingSlot` / `trailingAction`, which HTML forbids inside a native
 * `<button>`), or a non-interactive `<div>` when neither is supplied
 * (useful for pure readout rows).
 *
 * ### `asChild` (composition pattern)
 *
 * Pass `asChild` to render as a caller-provided element (e.g. a React Router
 * `<NavLink>`) while merging PanelItem's visual classes and aria attributes
 * onto it via Radix `Slot`. The consumer provides all children; PanelItem
 * provides the interactive state layer (hover, active, focus-ring,
 * aria-current, `group` modifier).
 *
 * ### `activeVariant`
 *
 * Controls how the active (`aria-current="page"`) state is styled:
 * - `"default"` — neutral `--surface-active` background,
 *   `--content-emphasised` text. Used in the assistant sidebar.
 * - `"branded"` — primary-tinted background, `--primary-base` text, bolder
 *   weight. Used in settings/admin sidebars for a branded highlight.
 */

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PanelItemProps {
  /** Leading icon. Omit for label-only rows (e.g. indented sub-items). */
  icon?: LucideIcon;
  /**
   * Custom leading content. When provided, overrides the `icon` prop —
   * the icon's slot is replaced by this ReactNode.
   */
  leadingSlot?: ReactNode;
  /** Row label. Pass a string for the common case; ReactNode accepted. */
  label: ReactNode;
  /**
   * Chevron-style icon rendered inline after the label (for sections that
   * can collapse/expand). Part of the left cluster so it sits adjacent to
   * the text, not at the row's trailing edge.
   */
  expandChevron?: LucideIcon;
  /**
   * Count / status chip. Pill-styled when the row is in Default state,
   * stripped in Hover / Active — both transitions happen automatically.
   */
  badge?: ReactNode;
  /**
   * Trailing slot (commonly an ellipsis / more-options button). Hidden by
   * default; revealed on hover or focus-within, while a child menu is open
   * (`aria-expanded="true"` on the trigger), and always when `active`.
   */
  trailingAction?: ReactNode;
  /** Selected state. Sets `aria-current="page"` automatically. */
  active?: boolean;
  /**
   * Active-state color treatment.
   * - `"default"` — neutral `--surface-active` bg, `--content-emphasised` text.
   * - `"branded"` — primary-tinted bg, `--primary-base` text, bolder weight.
   * @default "default"
   */
  activeVariant?: "default" | "branded";
  /**
   * Disabled state for the `onSelect` variant. Blocks click and Enter/Space
   * activation, removes the row from the tab order, and sets `aria-disabled`.
   * No effect on the anchor (`href`) / `asChild` / non-interactive variants.
   */
  disabled?: boolean;
  /** Click handler for the row itself (not `trailingAction`). */
  onSelect?: () => void;
  /** Render as `<a href>` for navigation rows. */
  href?: string;
  /**
   * When true, wrap the label in `MarqueeText` so an overflowing single-line
   * label scrolls horizontally on row hover and snaps back to the start when
   * the pointer leaves. Honors `prefers-reduced-motion`. Off by default.
   */
  marqueeOnHover?: boolean;
  className?: string;
  /** Optional accessible label override (defaults to `label` when it's a string). */
  "aria-label"?: string;
  /**
   * Render as a caller-provided child element (e.g. React Router `<NavLink>`)
   * while merging PanelItem's styling and aria attributes onto it. Uses
   * Radix `Slot`. When true, pass exactly one child element; PanelItem's own
   * `href` and `onSelect` props are ignored.
   */
  asChild?: boolean;
  /** Children. Required when `asChild` is true; ignored otherwise. */
  children?: ReactNode;
  ref?: Ref<HTMLAnchorElement | HTMLDivElement | HTMLElement>;
}

// ---------------------------------------------------------------------------
// Class composition
// ---------------------------------------------------------------------------

const ROW_BASE_CLASSES = [
  "group relative",
  "flex h-8 max-md:h-auto w-full items-center justify-between",
  "rounded-[6px] p-[8px] max-md:py-3 gap-[4px]",
  "text-left text-body-medium-lighter max-md:text-body-large-default",
  "transition-colors",
  "bg-transparent",
  "text-[var(--content-secondary)]",
  "outline-none",
].join(" ");

const INTERACTIVE_CLASSES = [
  "hover:bg-[var(--surface-hover)]",
  "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
  "cursor-pointer select-none",
].join(" ");

const ACTIVE_DEFAULT_CLASSES = [
  "aria-[current=page]:bg-[var(--surface-active)]",
  "aria-[current=page]:text-[var(--content-emphasised)]",
].join(" ");

const ACTIVE_BRANDED_CLASSES = [
  "aria-[current=page]:bg-[color-mix(in_oklab,var(--primary-base)_10%,transparent)]",
  "aria-[current=page]:text-[var(--primary-base)]",
  // eslint-disable-next-line no-restricted-syntax
  "aria-[current=page]:font-medium",
].join(" ");

const LEFT_CLUSTER_CLASSES = "flex min-w-0 flex-1 items-center gap-[8px]";

const LEADING_ICON_BASE_CLASSES = [
  "shrink-0",
  "text-[var(--content-tertiary)]",
  "group-hover:text-[var(--content-secondary)]",
].join(" ");

const ICON_ACTIVE_DEFAULT =
  "group-aria-[current=page]:text-[var(--content-default)]";
const ICON_ACTIVE_BRANDED =
  "group-aria-[current=page]:text-[var(--primary-base)]";

const LABEL_CLASSES = "min-w-0 flex-1 truncate";

const EXPAND_CHEVRON_CLASSES =
  "shrink-0 text-[var(--content-tertiary)]";

const RIGHT_CLUSTER_CLASSES = "flex items-center gap-2 shrink-0";

const BADGE_BASE_CLASSES = [
  "inline-flex items-center justify-center shrink-0",
  "text-label-small-default leading-none",
  "text-[var(--content-tertiary)]",
  "rounded-[4px] bg-[var(--surface-base)] px-[4px] py-[2px]",
  "group-hover:bg-transparent group-hover:rounded-none",
  "group-hover:px-0 group-hover:py-0",
  "group-aria-[current=page]:bg-transparent group-aria-[current=page]:rounded-none",
  "group-aria-[current=page]:px-0 group-aria-[current=page]:py-0",
].join(" ");

const TRAILING_ACTION_CLASSES = [
  "flex items-center shrink-0",
  "opacity-0 transition-opacity",
  "group-hover:opacity-100",
  // Keyboard path: reveal when the row or the action itself has focus, and
  // keep it visible while its menu is open (focus moves into the portal'd
  // menu content, so focus-within alone would let it fade mid-interaction).
  "group-focus-within:opacity-100",
  "has-[[aria-expanded=true]]:opacity-100",
  "group-aria-[current=page]:opacity-100",
  // Coarse-pointer (touch) devices have no hover to reveal the action — keep
  // it visible. Gates on pointer capability alone (not viewport width) so
  // tablets and wide mobile layouts are covered too; a coarse primary
  // pointer never matches desktop browsers or Electron.
  "pointer-coarse:opacity-100",
].join(" ");

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type SharedAnchorProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "children"
>;

function PanelItem({
  icon: Icon,
  leadingSlot,
  label,
  expandChevron: ExpandChevron,
  badge,
  trailingAction,
  active = false,
  activeVariant = "default",
  disabled = false,
  onSelect,
  href,
  marqueeOnHover = false,
  className,
  "aria-label": ariaLabel,
  asChild = false,
  children,
  ref,
  ...rest
}: PanelItemProps & SharedAnchorProps & HTMLAttributes<HTMLDivElement>) {
  const ariaCurrent = active ? ("page" as const) : undefined;
  const resolvedAriaLabel =
    ariaLabel ?? (typeof label === "string" ? label : undefined);

  const iconActiveClass =
    activeVariant === "branded" ? ICON_ACTIVE_BRANDED : ICON_ACTIVE_DEFAULT;

  const leadingIcon =
    leadingSlot !== undefined
      ? leadingSlot
      : Icon
        ? <Icon size={14} aria-hidden className={cn("max-md:size-4", LEADING_ICON_BASE_CLASSES, iconActiveClass)} />
        : null;

  const labelNode = marqueeOnHover ? (
    <MarqueeText>{label}</MarqueeText>
  ) : (
    <span className={LABEL_CLASSES}>{label}</span>
  );

  const expandChevronNode = ExpandChevron ? (
    <ExpandChevron
      size={12}
      aria-hidden
      className={EXPAND_CHEVRON_CLASSES}
    />
  ) : null;

  const badgeNode =
    badge != null ? <span className={BADGE_BASE_CLASSES}>{badge}</span> : null;

  const trailingNode = trailingAction ? (
    <span
      className={TRAILING_ACTION_CLASSES}
      onClick={(event: MouseEvent<HTMLSpanElement>) => {
        event.stopPropagation();
        event.preventDefault();
      }}
    >
      {trailingAction}
    </span>
  ) : null;

  const innerMarkup = (
    <>
      <span className={LEFT_CLUSTER_CLASSES}>
        {leadingIcon}
        {labelNode}
        {expandChevronNode}
      </span>
      <span className={RIGHT_CLUSTER_CLASSES}>
        {badgeNode}
        {trailingNode}
      </span>
    </>
  );

  const activeClasses =
    activeVariant === "branded" ? ACTIVE_BRANDED_CLASSES : ACTIVE_DEFAULT_CLASSES;
  const isInteractive = asChild || !!href || !!onSelect;
  const rowClasses = cn(
    ROW_BASE_CLASSES,
    isInteractive && INTERACTIVE_CLASSES,
    activeClasses,
    className,
  );

  // ── asChild variant ──────────────────────────────────────────────────
  if (asChild) {
    if (import.meta.env.DEV) {
      if (Icon || leadingSlot || badge || trailingAction || ExpandChevron) {
        console.warn(
          "PanelItem: icon, leadingSlot, badge, trailingAction, and expandChevron " +
            "are ignored when asChild is true — the consumer owns all children.",
        );
      }
    }
    return (
      <Slot
        data-slot="panel-item"
        ref={ref as Ref<HTMLElement>}
        className={rowClasses}
        aria-current={ariaCurrent}
        aria-label={resolvedAriaLabel}
        {...(rest as HTMLAttributes<HTMLElement>)}
      >
        {children}
      </Slot>
    );
  }

  // ── Anchor variant ─────────────────────────────────────────────────
  if (href) {
    const { onClick: anchorOnClick, ...anchorProps } =
      rest as SharedAnchorProps;
    return (
      <a
        {...anchorProps}
        data-slot="panel-item"
        ref={ref as Ref<HTMLAnchorElement>}
        href={href}
        className={rowClasses}
        aria-current={ariaCurrent}
        aria-label={resolvedAriaLabel}
        onClick={(event) => {
          anchorOnClick?.(event);
          if (!event.defaultPrevented) {
            onSelect?.();
          }
        }}
      >
        {innerMarkup}
      </a>
    );
  }

  // ── Button variant ─────────────────────────────────────────────────
  // Rendered as `<div role="button">` rather than `<button>` because rows
  // commonly host interactive children (pin toggles, ellipsis menus) in
  // their `leadingSlot` / `trailingAction` slots. HTML forbids nesting
  // interactive elements inside `<button>`, which React 19 flags as a
  // hydration error. The same `Enter`/`Space` activation, tab focus, and
  // screen-reader semantics are preserved via `role="button"` + `tabIndex`.
  // `disabled` is honored via `aria-disabled` + skipped activation +
  // `tabIndex={-1}`, matching native `<button disabled>` behavior.
  if (onSelect) {
    const {
      onClick: rowOnClick,
      onKeyDown: rowOnKeyDown,
      ...divProps
    } = rest as HTMLAttributes<HTMLDivElement>;

    const composedOnClick = (event: MouseEvent<HTMLDivElement>) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      rowOnClick?.(event);
      if (!event.defaultPrevented) {
        onSelect();
      }
    };

    const composedOnKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      rowOnKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect();
      }
    };

    return (
      <div
        {...divProps}
        data-slot="panel-item"
        ref={ref as Ref<HTMLDivElement>}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        className={rowClasses}
        aria-current={ariaCurrent}
        aria-label={resolvedAriaLabel}
        onClick={composedOnClick}
        onKeyDown={composedOnKeyDown}
      >
        {innerMarkup}
      </div>
    );
  }

  // ── Non-interactive fallback ────────────────────────────────────────
  const divProps = rest as HTMLAttributes<HTMLDivElement>;
  return (
    <div
      data-slot="panel-item"
      ref={ref as Ref<HTMLDivElement>}
      className={rowClasses}
      aria-current={ariaCurrent}
      aria-label={resolvedAriaLabel}
      {...divProps}
    >
      {innerMarkup}
    </div>
  );
}

export {
  PanelItem,
  type PanelItemProps,
  ROW_BASE_CLASSES,
  ACTIVE_DEFAULT_CLASSES,
  ACTIVE_BRANDED_CLASSES,
};

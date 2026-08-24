import { Slot } from "@radix-ui/react-slot";
import type { LucideIcon } from "lucide-react";
import {
  type ComponentProps,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../../utils/cn";
import { reportUnmergeableSlotChild } from "../../utils/slot-child";
import { CrossfadeStack } from "../crossfade-stack";

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
 * Renders `<div role="button">` when `onSelect` is provided (the row container
 * hosts interactive children in `leadingSlot` / `trailingAction`, which HTML
 * forbids inside a native `<button>`), or a non-interactive `<div>` when it is
 * not (useful for pure readout rows). A row that navigates supplies its own
 * anchor through `asChild`, so the link's target and routing stay with the
 * router the app uses.
 *
 * ### `asChild` (composition pattern)
 *
 * Pass `asChild` to render as a caller-provided element (e.g. a React Router
 * `<NavLink>`) while merging PanelItem's visual classes and aria attributes
 * onto it via Radix `Slot`. The consumer provides all children; PanelItem
 * provides the interactive state layer (hover, active, focus-ring,
 * aria-current, `group` modifier). It is the state layer alone, so the props
 * that describe a row's contents (`icon`, `label`, `badge`, `trailingAction`,
 * `onSelect`) belong to the child and are rejected here.
 *
 * ### `shape`
 *
 * - `"row"` (default): a full-width 6px-radius row, for lists and nav trees.
 * - `"pill"`: a capsule that hugs its content, stands at the panel's pill
 *   height, and carries a resting `--surface-lift` surface, for navigation
 *   chips that sit inline rather than filling a column. Everything else
 *   (hover, active, badge, trailing action, link/button semantics) is
 *   unchanged, which is the point: a pill is a differently-shaped row, not a
 *   different component.
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

/** Shape, state, and styling: true of a row however its content is supplied. */
interface PanelItemFrameProps {
  /**
   * Row geometry.
   * - `"row"` fills its container at a 6px radius.
   * - `"pill"` hugs its content as a capsule on `--surface-lift`.
   * @default "row"
   */
  shape?: "row" | "pill";
  /** Selected state. Sets `aria-current="page"` automatically. */
  active?: boolean;
  /**
   * Active-state color treatment.
   * - `"default"` — neutral `--surface-active` bg, `--content-emphasised` text.
   * - `"branded"` — primary-tinted bg, `--primary-base` text, bolder weight.
   * @default "default"
   */
  activeVariant?: "default" | "branded";
  className?: string;
  /** Optional accessible label override (defaults to `label` when it's a string). */
  "aria-label"?: string;
}

/** PanelItem renders the row's contents from these props. */
interface PanelItemContentProps
  extends PanelItemFrameProps,
    Omit<ComponentProps<"div">, "children" | "className" | "aria-label"> {
  asChild?: false;
  /** Ignored: this variant builds its own children from the props below. */
  children?: never;
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
   * Drops the badge's pill chrome (background, rounding, padding) at every
   * state, leaving just its content, e.g. a plain status dot that shouldn't
   * sit in a background box. Default `false`, matching {@link badge}'s
   * usual count/label chip look.
   */
  badgeBare?: boolean;
  /**
   * Trailing slot (commonly an ellipsis / more-options button). Hidden by
   * default; revealed on hover or focus-within, while a child menu is open
   * (`aria-expanded="true"` on the trigger), and always when `active`.
   *
   * Where the device cannot hover the trailing action stays visible, since
   * there is nothing to reveal it. If the row already has its own touch
   * affordance (long-press to bottom sheet, swipe-to-reveal,
   * etc.), pass `undefined` here on touch rather than rendering a redundant
   * ellipsis: an always-visible-but-inert trailing element still reserves
   * layout space next to `badge`, which reads as broken.
   */
  trailingAction?: ReactNode;
  /**
   * Disabled state for the `onSelect` variant. Blocks click and Enter/Space
   * activation, removes the row from the tab order, and sets `aria-disabled`.
   * No effect on the `asChild` / non-interactive variants.
   */
  disabled?: boolean;
  /** Click handler for the row itself (not `trailingAction`). */
  onSelect?: () => void;
  /**
   * When true, wrap the label in `MarqueeText` so an overflowing single-line
   * label scrolls horizontally on row hover and snaps back to the start when
   * the pointer leaves. Honors `prefers-reduced-motion`. Off by default.
   */
  marqueeOnHover?: boolean;
  /**
   * This row is a control whose activation a parent owns - a popover or
   * bottom-sheet trigger cloning it via `asChild`. Renders the same
   * interactive shell `onSelect` does (role, tab stop, focus ring, pointer)
   * without taking a handler, because the parent supplies `onClick` and
   * `onKeyDown` itself. Without it the row renders as an inert `<div>`: the
   * parent's handlers still land, so it works by mouse, and silently loses
   * keyboard and screen-reader access.
   */
  trigger?: boolean;
}

/**
 * The caller supplies the whole element (e.g. a React Router `<NavLink>` or a
 * `Collapsible.Trigger`) and PanelItem merges its styling and aria attributes
 * onto it through Radix `Slot`.
 *
 * The content and behaviour props are typed out rather than left unused: the
 * child owns its own children, link target, and handlers, so a row that passes
 * both a child and an `icon` is asking for two different things at once. The
 * `never`s make that a type error at the call site instead of a prop that is
 * silently dropped at runtime.
 */
interface PanelItemSlotProps
  extends PanelItemFrameProps,
    Omit<HTMLAttributes<HTMLElement>, "children" | "className" | "aria-label"> {
  asChild: true;
  /**
   * The one element that becomes the rendered row, and the one this row's ref
   * points at. A fragment type-checks and cannot work: see
   * {@link reportUnmergeableSlotChild}.
   */
  children: ReactElement;
  ref?: Ref<HTMLElement>;
  icon?: never;
  leadingSlot?: never;
  label?: never;
  expandChevron?: never;
  badge?: never;
  badgeBare?: never;
  trailingAction?: never;
  marqueeOnHover?: never;
  disabled?: never;
  onSelect?: never;
  trigger?: never;
}

type PanelItemProps = PanelItemContentProps | PanelItemSlotProps;

// ---------------------------------------------------------------------------
// Class composition
// ---------------------------------------------------------------------------

const ROW_BASE_CLASSES = [
  /* Named as well as bare: slot content targets this row with
     `group-hover/panel-item:`, which an unnamed group does not match, and
     existing callers still rely on plain `group-hover:`. Both markers, so
     neither form silently stops working. */
  "group/panel-item group relative",
  "flex h-8 max-md:h-auto w-full items-center justify-between",
  "rounded-[6px] p-[8px] max-md:py-3 gap-[4px]",
  "text-left text-body-medium-lighter max-md:text-body-large-default",
  "transition-colors",
  "bg-transparent",
  "text-[var(--content-secondary)]",
  "outline-none",
].join(" ");

const INTERACTIVE_CLASSES = [
  "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
  "cursor-pointer select-none",
].join(" ");

/**
 * The hover surface, which differs by shape because the shapes rest on
 * different things. A row rests transparent, where `--surface-hover` - a 6%
 * translucent overlay - is exactly what it was built for. A pill rests on
 * `--surface-lift`, where that same overlay composites *darker* than the
 * resting surface and the pill reads as having no hover at all;
 * `--surface-active` is the step up from lifted.
 *
 * Both stay overridable through `--panel-item-hover`, so a tinted pill still
 * supplies its own lightened hue and never reaches either fallback.
 */
const ROW_HOVER_CLASS =
  "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-hover))]";
const PILL_HOVER_CLASS =
  "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-active))]";

/**
 * {@link PanelItemProps.shape} `"pill"`: a capsule that sizes to its content
 * and carries a resting surface, so it reads as a chip sitting in a column
 * rather than a row filling one. Radius, width, height, and surface, so hover,
 * active, and every slot behave exactly as they do on a row.
 *
 * `w-fit` rather than `w-auto`: the root is a block-level flex container, and
 * `width: auto` on one fills its containing block, so a pill would stretch to
 * row width in every ordinary layout. `width: fit-content` shrink-wraps while
 * leaving `display: flex` alone, which the row's internal layout depends on.
 *
 * `max-w-full` beside it is not redundant. A label is `white-space: nowrap`,
 * so its min-content contribution is the whole string and `fit-content`
 * resolves to the full text however narrow the panel is; the label's
 * `min-w-0` cannot pull that back, `min-width` being a floor and not a cap.
 * The cap makes the used width definite, which is the condition flex
 * shrinking needs, so a label too long for the panel truncates.
 *
 * A pill is taller than a row, and how much taller is the panel's decision
 * rather than each caller's: `SideMenu` publishes `--side-menu-tile-size`, the
 * height its collapsed tiles are drawn at, and a pill mounted in one takes it,
 * so a pill and the circle it collapses into cannot end up at two heights. The
 * fallback is the same measurement for a pill mounted anywhere else.
 *
 * On a touch viewport it applies as a floor rather than a height. The row's
 * `max-md:h-auto` still governs, so a pill grows to its content as it always
 * has; the floor only stops it sitting below the height the panel publishes.
 * Without it the pill ignores that value entirely and lands on whatever its
 * padding and line-height happen to sum to, which is how a panel that stands
 * its rows taller for touch ends up unable to say so.
 */
/**
 * A pill reads three optional custom properties, each falling back to the
 * untinted surface, so a caller can tint one without this component taking a
 * colour prop or a caller reaching in with `style` overrides:
 *
 * - `--panel-item-bg` — resting surface
 * - `--panel-item-hover` — hover surface
 * - `--panel-item-fg` — foreground paired with the above for contrast
 *
 * Follows the recipe the identity page already uses for avatar-tinted
 * surfaces (`--card-bg` / `--card-hover` / `--card-flood-fg`): declare the
 * colours on an ancestor, consume them here through a fallback, and the
 * whole treatment collapses to the default when nothing declares them.
 */
const PILL_SHAPE_CLASSES = [
  "w-fit max-w-full rounded-full",
  "h-[var(--side-menu-tile-size,36px)]",
  "max-md:min-h-[var(--side-menu-tile-size,36px)]",
  "bg-[var(--panel-item-bg,var(--surface-lift))]",
  "text-[color:var(--panel-item-fg,inherit)]",
].join(" ");

/* The active surface reads the same tint properties the resting one does, so
   a tinted pill stays tinted while active. Without that, this rule and the
   resting `--panel-item-bg` are different variants - tailwind-merge keeps
   both, and the aria one wins whenever it applies, dropping the tint at
   exactly the moment the row is the current page. Untinted callers reach
   `--surface-active` as before. */
const ACTIVE_DEFAULT_CLASSES = [
  "aria-[current=page]:bg-[var(--panel-item-active,var(--panel-item-bg,var(--surface-active)))]",
  "aria-[current=page]:text-[var(--content-emphasised)]",
].join(" ");

const ACTIVE_BRANDED_CLASSES = [
  "aria-[current=page]:bg-[color-mix(in_oklab,var(--primary-base)_10%,transparent)]",
  "aria-[current=page]:text-[var(--primary-base)]",
  // eslint-disable-next-line no-restricted-syntax
  "aria-[current=page]:font-medium",
].join(" ");

/**
 * `--panel-item-gap` opens the leading-icon-to-label gap to callers whose
 * leading slot is larger than an icon (a chip, an avatar), where 8px reads as
 * cramped. Same recipe as the `--panel-item-*` colour properties above:
 * declare it on an ancestor, fall back to the default, and a row that never
 * declares it is unchanged.
 */
const LEFT_CLUSTER_CLASSES =
  "flex min-w-0 flex-1 items-center gap-[var(--panel-item-gap,8px)]";

/**
 * `--panel-item-icon-fg` lets a caller recolor just the leading icon (e.g. the
 * New Chat row's plus, tinted to the assistant's own accent) without touching
 * every other icon on the surface: it falls back to the usual tertiary gray,
 * so a row that never declares it looks exactly as before.
 */
const LEADING_ICON_BASE_CLASSES = [
  "shrink-0",
  "text-[color:var(--panel-item-icon-fg,var(--content-tertiary))]",
  "[@media(hover:hover)]:group-hover:text-[color:var(--panel-item-icon-fg,var(--content-secondary))]",
].join(" ");

const ICON_ACTIVE_DEFAULT =
  "group-aria-[current=page]:text-[var(--content-default)]";
const ICON_ACTIVE_BRANDED =
  "group-aria-[current=page]:text-[var(--primary-base)]";

const LABEL_CLASSES = "min-w-0 flex-1 truncate";

const EXPAND_CHEVRON_CLASSES = "shrink-0 text-[var(--content-tertiary)]";

const RIGHT_CLUSTER_CLASSES = "flex items-center gap-2 shrink-0";

const BADGE_BASE_CLASSES = [
  "inline-flex items-center justify-center shrink-0",
  "text-label-small-default leading-none",
  "text-[var(--content-tertiary)]",
  "rounded-[4px] bg-[var(--surface-base)] px-[4px] py-[2px]",
  "[@media(hover:hover)]:group-hover:bg-transparent [@media(hover:hover)]:group-hover:rounded-none",
  "[@media(hover:hover)]:group-hover:px-0 [@media(hover:hover)]:group-hover:py-0",
  "group-aria-[current=page]:bg-transparent group-aria-[current=page]:rounded-none",
  "group-aria-[current=page]:px-0 group-aria-[current=page]:py-0",
].join(" ");

/** {@link PanelItemProps.badgeBare}: layout only, no pill chrome at any state. */
const BADGE_BARE_CLASSES = "inline-flex items-center justify-center shrink-0";

/**
 * 8px inset from the row's true right edge, for a bare badge with no
 * `trailingAction` beside it (e.g. conversation-row's mobile status dot,
 * once its ellipsis is gone). Only applied then: with a trailing action
 * present, `RIGHT_CLUSTER_CLASSES`'s own `gap-2` already separates the two,
 * and this would stack on top of it.
 */
const BADGE_BARE_ALONE_CLASSES = "mr-2";

/**
 * The trailing action carries `data-reveal`, so the row keeps it out of the way
 * until it is wanted; a row the nav marks as the current page carries
 * `data-reveal-hold` and keeps it visible, being the row the user is in. The
 * conditions live in the design library's stylesheet.
 */
const TRAILING_ACTION_CLASSES = "flex items-center shrink-0";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** The row shell: geometry, active treatment, and whether it answers a pointer. */
function rowClasses({
  shape,
  active,
  activeVariant,
  interactive,
  className,
}: {
  shape: "row" | "pill";
  active: boolean;
  activeVariant: "default" | "branded";
  interactive: boolean;
  className: string | undefined;
}): string {
  return cn(
    ROW_BASE_CLASSES,
    interactive && INTERACTIVE_CLASSES,
    interactive && (shape === "pill" ? PILL_HOVER_CLASS : ROW_HOVER_CLASS),
    activeVariant === "branded"
      ? ACTIVE_BRANDED_CLASSES
      : ACTIVE_DEFAULT_CLASSES,
    shape === "pill" && PILL_SHAPE_CLASSES,
    className,
  );
}

/**
 * Dispatches on where the row's content comes from, which is the same question
 * as what element it renders. Each branch takes one variant's props, so the
 * attributes it spreads and the element its ref points at agree by
 * construction rather than by assertion.
 */
function PanelItem(props: PanelItemProps) {
  if (props.asChild === true) {
    return <PanelItemSlotRow {...props} />;
  }
  return <PanelItemContentRow {...props} />;
}

function PanelItemSlotRow({
  asChild: _asChild,
  shape = "row",
  active = false,
  activeVariant = "default",
  className,
  "aria-label": ariaLabel,
  children,
  ref,
  ...rest
}: PanelItemSlotProps) {
  reportUnmergeableSlotChild("PanelItem", children);
  return (
    <Slot
      data-slot="panel-item"
      ref={ref}
      className={rowClasses({
        shape,
        active,
        activeVariant,
        interactive: true,
        className,
      })}
      aria-current={active ? "page" : undefined}
      aria-label={ariaLabel}
      {...rest}
    >
      {children}
    </Slot>
  );
}

function PanelItemContentRow({
  asChild: _asChild,
  children: _children,
  icon: Icon,
  leadingSlot,
  label,
  expandChevron: ExpandChevron,
  badge,
  badgeBare = false,
  trailingAction,
  shape = "row",
  active = false,
  activeVariant = "default",
  disabled = false,
  onSelect,
  marqueeOnHover = false,
  className,
  "aria-label": ariaLabel,
  trigger = false,
  ref,
  onClick,
  onKeyDown,
  ...rest
}: PanelItemContentProps) {
  const ariaCurrent = active ? ("page" as const) : undefined;
  const resolvedAriaLabel =
    ariaLabel ?? (typeof label === "string" ? label : undefined);

  const iconActiveClass =
    activeVariant === "branded" ? ICON_ACTIVE_BRANDED : ICON_ACTIVE_DEFAULT;

  const leadingIcon =
    leadingSlot !== undefined ? (
      leadingSlot
    ) : Icon ? (
      <Icon
        size={14}
        aria-hidden
        className={cn(
          "max-md:size-4",
          LEADING_ICON_BASE_CLASSES,
          iconActiveClass,
        )}
      />
    ) : null;

  const labelNode = marqueeOnHover ? (
    <MarqueeText>{label}</MarqueeText>
  ) : (
    <span className={LABEL_CLASSES}>{label}</span>
  );

  const expandChevronNode = ExpandChevron ? (
    <ExpandChevron size={12} aria-hidden className={EXPAND_CHEVRON_CLASSES} />
  ) : null;

  const crossfadeBadgeAndTrailing = badge != null && trailingAction != null;

  const badgeNode =
    badge != null ? (
      <span
        className={cn(
          badgeBare ? BADGE_BARE_CLASSES : BADGE_BASE_CLASSES,
          badgeBare && !trailingAction && BADGE_BARE_ALONE_CLASSES,
        )}
        /* A row with both parts crossfades them in one slot, so the badge
           yields wherever the trailing action is shown. */
        data-reveal-yield={crossfadeBadgeAndTrailing ? "" : undefined}
      >
        {badge}
      </span>
    ) : null;

  const trailingNode = trailingAction ? (
    <span
      className={TRAILING_ACTION_CLASSES}
      data-reveal=""
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
        {crossfadeBadgeAndTrailing ? (
          <CrossfadeStack>
            {badgeNode}
            {trailingNode}
          </CrossfadeStack>
        ) : (
          <>
            {badgeNode}
            {trailingNode}
          </>
        )}
      </span>
    </>
  );

  const interactive = onSelect != null || trigger;
  const classes = rowClasses({
    shape,
    active,
    activeVariant,
    interactive,
    className,
  });

  // Rendered as `<div role="button">` rather than `<button>` because rows
  // commonly host interactive children (pin toggles, ellipsis menus) in their
  // `leadingSlot` / `trailingAction` slots. HTML forbids nesting interactive
  // elements inside `<button>`, which React 19 flags as a hydration error. The
  // same `Enter`/`Space` activation, tab focus, and screen-reader semantics are
  // preserved via `role="button"` + `tabIndex`. `disabled` is honored via
  // `aria-disabled` + skipped activation + `tabIndex={-1}`, matching native
  // `<button disabled>` behavior.
  if (interactive) {
    const composedOnClick = (event: MouseEvent<HTMLDivElement>) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      onClick?.(event);
      if (!event.defaultPrevented) {
        onSelect?.();
      }
    };

    const composedOnKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) {
        return;
      }
      onKeyDown?.(event);
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        /* A trigger has no handler of its own; the parent's `onKeyDown` above
           has already run and is what opens it. Preventing default here would
           swallow the space key for it. */
        if (!onSelect) {
          return;
        }
        event.preventDefault();
        onSelect();
      }
    };

    return (
      <div
        {...rest}
        data-slot="panel-item"
        ref={ref}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        className={classes}
        data-reveal-row=""
        data-reveal-hold={active ? "" : undefined}
        aria-current={ariaCurrent}
        aria-label={resolvedAriaLabel}
        onClick={composedOnClick}
        onKeyDown={composedOnKeyDown}
      >
        {innerMarkup}
      </div>
    );
  }

  return (
    <div
      data-slot="panel-item"
      ref={ref}
      className={classes}
      data-reveal-row=""
      data-reveal-hold={active ? "" : undefined}
      aria-current={ariaCurrent}
      aria-label={resolvedAriaLabel}
      onClick={onClick}
      onKeyDown={onKeyDown}
      {...rest}
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

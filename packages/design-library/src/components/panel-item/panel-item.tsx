import { Slot } from "@radix-ui/react-slot";
import type { LucideIcon } from "lucide-react";
import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../../utils.js";

import { MarqueeText } from "./marquee-text.js";

/**
 * Sidepanel / navigation row primitive. Figma node 1392:10339
 * ("Sidepanel Item"). One row you can drop into a sidebar, settings nav,
 * admin tree, menu, or any list where rows need the Figma hover / active
 * state treatment.
 *
 * Visual spec (pulled directly from 1392:10339):
 *
 * - 32px tall, `rounded-[6px]`, `p-[8px]`, `gap-[8px]` between leading icon
 *   and label.
 * - Default: transparent background, `--content-tertiary` icon,
 *   `--content-secondary` label, pill-styled `badge` on `--surface-base`.
 * - Hover (CSS `:hover`): `--surface-hover` background (the token already
 *   carries the 6% / 8% alpha prescribed by Figma), icon brightens to
 *   `--content-secondary`, badge loses its pill chrome, `trailingAction`
 *   fades in.
 * - Active (controlled by the `active` prop, renders `aria-current="page"`):
 *   `--surface-active` background, icon brightens to `--content-default`,
 *   label brightens to `--content-emphasised`, badge stays pill-less,
 *   `trailingAction` stays visible.
 *
 * Label typography uses the `body-medium-lighter` token (14/400/18),
 * unified across light and dark modes per design call 2026-04-23 — this
 * intentionally drops the previous mode-aware weight swap.
 *
 * Supplies `role="button"` / `<a>` semantics automatically based on whether
 * you pass `href` or `onSelect`. When neither is supplied we render a
 * non-interactive `<div>` (useful for pure readout rows).
 *
 * ### `asChild` (composition pattern)
 *
 * Pass `asChild` to render as a caller-provided element (e.g. a Next.js
 * `<Link>`) while merging PanelItem's visual classes and aria attributes
 * onto it via Radix `Slot` — the same pattern as the `Button` primitive.
 * The consumer provides all children; PanelItem provides the interactive
 * state layer (hover, active, focus-ring, aria-current, `group` modifier).
 *
 * ```tsx
 * <PanelItem asChild active={isActive} activeVariant="branded">
 *   <Link href="/settings" className="no-underline">
 *     <span className="flex min-w-0 flex-1 items-center gap-[8px]">
 *       <Globe
 *         size={16}
 *         aria-hidden
 *         className="shrink-0 text-[var(--content-tertiary)]
 *           group-hover:text-[var(--content-secondary)]
 *           group-aria-[current=page]:text-[var(--primary-base)]"
 *       />
 *       Settings
 *     </span>
 *   </Link>
 * </PanelItem>
 * ```
 *
 * The row uses `justify-between` to separate a left cluster (icon + label)
 * from a right cluster (badge + trailing action). When using `asChild`,
 * wrap icon + label in a `<span className="flex min-w-0 flex-1 items-center
 * gap-[4px]">` to keep them clustered on the left — otherwise
 * `justify-between` pushes them apart.
 *
 * ### `activeVariant`
 *
 * Controls how the active (`aria-current="page"`) state is styled:
 * - `"default"` — neutral `--surface-active` background, `--content-emphasised`
 *   text. Used in the assistant sidebar.
 * - `"branded"` — primary-tinted background, `--primary-base` text, bolder
 *   weight. Used in settings/admin sidebars for a branded highlight.
 */

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PanelItemProps {
  /** Leading icon. Omit for label-only rows (e.g. indented sub-items). */
  icon?: LucideIcon;
  /**
   * Custom leading content. When provided, overrides the `icon` prop —
   * the icon's slot is replaced by this ReactNode. Use when the leading
   * affordance needs behavior (a click, an opacity transition, a badge)
   * beyond what a plain lucide glyph gives you.
   */
  leadingSlot?: ReactNode;
  /**
   * Row label. Pass a string for the common case; a `ReactNode` is accepted
   * so consumers can wrap with truncation, marquees, or other ornamentation.
   */
  label: ReactNode;
  /**
   * Chevron-style icon rendered inline after the label (for sections that
   * can collapse/expand). Part of the left cluster so it sits adjacent to
   * the text, not at the row's trailing edge.
   */
  expandChevron?: LucideIcon;
  /**
   * Count / status chip. Figma's spec pill-styles it when the row is in its
   * Default state and strips the pill in Hover / Active — we handle both
   * transitions automatically.
   */
  badge?: ReactNode;
  /**
   * Trailing slot (commonly an ellipsis / more-options button). Hidden by
   * default, revealed on hover, and always visible when `active`. Pass
   * native event handlers to make it interactive; the row's own click
   * handler only fires for clicks outside this slot.
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
  /** Click handler for the row itself (not `trailingAction`). */
  onSelect?: () => void;
  /** Render as `<a href>` instead of `<button>`. */
  href?: string;
  /**
   * When true, wrap the label in `MarqueeText` so an overflowing single-line
   * label scrolls horizontally on row hover and snaps back to the start when
   * the pointer leaves. Labels that already fit are unaffected (no jitter,
   * no layout shift). Honors `prefers-reduced-motion`. Off by default to
   * keep existing call sites unchanged.
   */
  marqueeOnHover?: boolean;
  className?: string;
  /** Optional accessible label override (defaults to `label` when it's a string). */
  "aria-label"?: string;
  /**
   * Render as a caller-provided child element (e.g. Next.js `<Link>`) while
   * merging PanelItem's styling and aria attributes onto it. Uses Radix `Slot`
   * (same pattern as `Button`). When true, pass exactly one child element;
   * PanelItem's own `href` and `onSelect` props are ignored.
   */
  asChild?: boolean;
  /** Children. Required when `asChild` is true; ignored otherwise. */
  children?: ReactNode;
  ref?: Ref<HTMLAnchorElement | HTMLButtonElement | HTMLDivElement | HTMLElement>;
}

// ---------------------------------------------------------------------------
// Class composition — broken out so the test file can assert on a stable
// shape and so the gallery can reuse the row class for static previews.
// ---------------------------------------------------------------------------

/**
 * Base row classes shared across all active variants. The `group` modifier
 * lets descendants react to hover / active state via `group-hover:` and
 * `group-aria-[current=page]:` without extra JS.
 */
export const ROW_BASE_CLASSES = [
  "group relative",
  // Mobile (`max-md`): row grows to fit body-large-lighter (16px) text + 12px
  // py = ~40px tall, matching the icon-button touch targets elsewhere on
  // mobile. Desktop stays at the Figma 32px spec.
  "flex h-8 max-md:h-auto w-full items-center justify-between",
  "rounded-[6px] p-[8px] max-md:py-3 gap-[4px]",
  // Mobile: bump label to body-large-default (16/500/100) for thumb-friendly
  // tap targets. The typography classes are registered as Tailwind
  // `@utility` declarations in globals.css so they can be variant-prefixed.
  "text-left text-body-medium-lighter max-md:text-body-large-default",
  "transition-colors",
  "bg-transparent",
  "text-[var(--content-secondary)]",
  "hover:bg-[var(--surface-hover)]",
  "outline-none",
  "focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
  "cursor-pointer select-none",
].join(" ");

/** Neutral active state — assistant sidebar, menus. */
export const ACTIVE_DEFAULT_CLASSES = [
  "aria-[current=page]:bg-[var(--surface-active)]",
  "aria-[current=page]:text-[var(--content-emphasised)]",
].join(" ");

/** Branded active state — settings/admin sidebars. Primary-tinted bg + bold. */
export const ACTIVE_BRANDED_CLASSES = [
  "aria-[current=page]:bg-[color-mix(in_oklab,var(--primary-base)_10%,transparent)]",
  "aria-[current=page]:text-[var(--primary-base)]",
  // typography: off-scale — variant-prefixed weight bump (400→500) for branded active;
  // text-body-medium-default isn't a @utility so Tailwind v4 can't variant-prefix it
  // eslint-disable-next-line no-restricted-syntax
  "aria-[current=page]:font-medium",
].join(" ");

const LEFT_CLUSTER_CLASSES =
  "flex min-w-0 flex-1 items-center gap-[8px]";

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

/**
 * Badge has two presentations:
 * - Default: pill (bg, padding, radius).
 * - Hover / Active: bare text (no bg, no padding).
 * We keep it CSS-only so no mouseenter/leave wiring is needed.
 */
const BADGE_BASE_CLASSES = [
  "inline-flex items-center justify-center shrink-0",
  "text-label-small-default leading-none",
  "text-[var(--content-tertiary)]",
  // Default: pill
  "rounded-[4px] bg-[var(--surface-base)] px-[4px] py-[2px]",
  // Hover strips the pill
  "group-hover:bg-transparent group-hover:rounded-none",
  "group-hover:px-0 group-hover:py-0",
  // Active strips the pill
  "group-aria-[current=page]:bg-transparent group-aria-[current=page]:rounded-none",
  "group-aria-[current=page]:px-0 group-aria-[current=page]:py-0",
].join(" ");

/**
 * Trailing action is hidden by default, revealed on hover, always visible
 * when active. Kept as opacity toggles so it doesn't shift layout.
 */
const TRAILING_ACTION_CLASSES = [
  "flex items-center shrink-0",
  "opacity-0 transition-opacity",
  "group-hover:opacity-100",
  "group-aria-[current=page]:opacity-100",
].join(" ");

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type SharedAnchorProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "children"
>;
type SharedButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "type"
>;

export function PanelItem({
  icon: Icon,
  leadingSlot,
  label,
  expandChevron: ExpandChevron,
  badge,
  trailingAction,
  active = false,
  activeVariant = "default",
  onSelect,
  href,
  marqueeOnHover = false,
  className,
  "aria-label": ariaLabel,
  asChild = false,
  children,
  ref,
  ...rest
}: PanelItemProps & SharedAnchorProps & SharedButtonProps) {
  const ariaCurrent = active ? ("page" as const) : undefined;
  const resolvedAriaLabel =
    ariaLabel ?? (typeof label === "string" ? label : undefined);

  const iconActiveClass =
    activeVariant === "branded" ? ICON_ACTIVE_BRANDED : ICON_ACTIVE_DEFAULT;

  const leadingIcon =
    leadingSlot !== undefined
      ? leadingSlot
      : Icon
        ? <Icon size={14} aria-hidden className={cn(LEADING_ICON_BASE_CLASSES, iconActiveClass)} />
        : null;

  // When `marqueeOnHover` is set, `MarqueeText` becomes the label slot and
  // owns the `min-w-0 flex-1 overflow-hidden` layout itself (no static
  // `truncate` wrapper — it manages truncation internally based on whether
  // the text actually overflows).
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

  /**
   * Wrap `trailingAction` so clicks don't bubble up and fire `onSelect` on
   * the row. Consumers still receive clicks on whatever element they pass
   * (button, link, icon-button).
   */
  const trailingNode = trailingAction ? (
    <span
      className={TRAILING_ACTION_CLASSES}
      onClick={(event) => event.stopPropagation()}
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
  const rowClasses = cn(ROW_BASE_CLASSES, activeClasses, className);

  // ── asChild variant ──────────────────────────────────────────────────
  // Merges PanelItem's state classes onto the caller's element via Slot.
  // The consumer provides all children (icon, label, etc.).
  if (asChild) {
    if (import.meta.env?.DEV) {
      if (Icon || leadingSlot || badge || trailingAction || ExpandChevron) {
        console.warn(
          "PanelItem: icon, leadingSlot, badge, trailingAction, and expandChevron " +
            "are ignored when asChild is true — the consumer owns all children.",
        );
      }
    }
    return (
      <Slot
        ref={ref as Ref<HTMLElement>}
        data-slot="panel-item"
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
        ref={ref as Ref<HTMLAnchorElement>}
        data-slot="panel-item"
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

  // Button variant — renders <button type="button"> when `onSelect` is provided.
  if (onSelect) {
    const {
      onClick: buttonOnClick,
      onKeyDown: buttonOnKeyDown,
      ...buttonProps
    } = rest as SharedButtonProps;

    // Compose explicitly so a caller-provided onClick (e.g. Radix
    // `Popover.Trigger asChild` injecting its own) runs alongside our
    // onSelect instead of silently overriding it via a later spread.
    const composedOnClick = (event: MouseEvent<HTMLButtonElement>) => {
      buttonOnClick?.(event);
      if (!event.defaultPrevented) {
        onSelect();
      }
    };

    // Native <button> synthesises click from Enter/Space, so we don't
    // preventDefault here — doing so would block Radix's keyboard
    // activation path when this row is used as a popover trigger. We
    // still forward the caller's onKeyDown for observability.
    return (
      <button
        {...buttonProps}
        ref={ref as Ref<HTMLButtonElement>}
        data-slot="panel-item"
        type="button"
        className={rowClasses}
        aria-current={ariaCurrent}
        aria-label={resolvedAriaLabel}
        onClick={composedOnClick}
        onKeyDown={buttonOnKeyDown}
      >
        {innerMarkup}
      </button>
    );
  }

  // ── Non-interactive fallback ────────────────────────────────────────
  const divProps = rest as HTMLAttributes<HTMLDivElement>;
  return (
    <div
      ref={ref as Ref<HTMLDivElement>}
      data-slot="panel-item"
      className={rowClasses}
      aria-current={ariaCurrent}
      aria-label={resolvedAriaLabel}
      {...divProps}
    >
      {innerMarkup}
    </div>
  );
}

import { type ComponentProps, type ReactNode } from "react";

import { ChevronRight } from "lucide-react";

import { cn } from "../utils/cn";

export interface ListRowProps
  extends Omit<ComponentProps<"div">, "title" | "onClick"> {
  /**
   * Control rendered at the far left, outside the interactive content area so
   * activating it does not trigger the row's `onClick` (e.g. an enable toggle
   * or a leading icon).
   */
  leading?: ReactNode;
  /** Primary line. Truncates to a single line. */
  title: ReactNode;
  /** Secondary line beneath the title. Wraps freely. */
  subtitle?: ReactNode;
  /**
   * Right-aligned metadata cluster (cost, counts, badges, status dots…).
   * Rendered before the chevron.
   */
  trailing?: ReactNode;
  /**
   * Render a trailing chevron affordance. Defaults to `true` when the row is
   * interactive (`onClick` or `href` set), `false` otherwise.
   */
  showChevron?: boolean;
  /** Apply the selected (active) background treatment. */
  selected?: boolean;
  disabled?: boolean;
  /**
   * Makes the title/subtitle/trailing cluster an interactive button. The
   * `leading` slot stays outside it.
   */
  onClick?: () => void;
  /** Render the interactive content area as an anchor instead of a button. */
  href?: string;
  /** Accessible label for the interactive content area. */
  contentAriaLabel?: string;
}

/**
 * Generic settings/list row primitive. Models the "Scheduled Jobs" row used on
 * the Activity page: an optional leading control, a title + subtitle stack, and
 * a right-aligned trailing cluster with an optional chevron. Adjacent rows are
 * separated by a hairline divider (`[&+&]` sibling border), so stack them flush
 * (no `space-y`) to get the divided-list look.
 *
 * Interactivity is opt-in: pass `onClick` (button) or `href` (anchor) to make
 * the content area activatable with hover + focus-ring treatment; omit both for
 * a read-only readout row.
 */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  showChevron,
  selected,
  disabled,
  onClick,
  href,
  contentAriaLabel,
  className,
  ref,
  ...rest
}: ListRowProps) {
  const interactive = Boolean(onClick || href);
  const chevron = showChevron ?? interactive;

  const content = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-body-medium-default text-[var(--content-default)]">
          {title}
        </span>
        {subtitle != null ? (
          <span className="min-w-0 text-label-small-default text-[var(--content-tertiary)]">
            {subtitle}
          </span>
        ) : null}
      </div>
      {trailing != null || chevron ? (
        <div className="flex shrink-0 items-center gap-4">
          {trailing}
          {chevron ? (
            <ChevronRight className="h-4 w-4 text-[var(--content-tertiary)]" />
          ) : null}
        </div>
      ) : null}
    </>
  );

  const contentClassName =
    "flex min-w-0 flex-1 items-center gap-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";

  let contentNode: ReactNode;
  if (href && !disabled) {
    contentNode = (
      <a
        href={href}
        aria-label={contentAriaLabel}
        className={cn(contentClassName, "cursor-pointer")}
      >
        {content}
      </a>
    );
  } else if (onClick) {
    contentNode = (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={contentAriaLabel}
        className={cn(
          contentClassName,
          "cursor-pointer disabled:cursor-not-allowed",
        )}
      >
        {content}
      </button>
    );
  } else {
    contentNode = <div className={contentClassName}>{content}</div>;
  }

  return (
    <div
      {...rest}
      ref={ref}
      data-slot="list-row"
      className={cn(
        "flex items-center gap-3 rounded-md px-2 py-3 transition-colors",
        "[&+&]:border-t [&+&]:border-[var(--border-base)]",
        interactive &&
          !selected &&
          !disabled &&
          "hover:bg-[var(--surface-hover)]",
        selected && "bg-[var(--surface-active)]",
        disabled && "opacity-60",
        className,
      )}
    >
      {leading}
      {contentNode}
    </div>
  );
}

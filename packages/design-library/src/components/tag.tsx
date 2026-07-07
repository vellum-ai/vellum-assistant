import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import {
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "../utils/cn";

/**
 * Compact label / chip primitive. Figma node 816:4530.
 *
 * Renders a 24px pill with a soft tone-matched background, a colored leading
 * icon, and `--content-default` text. One style per tone — no strong/weak
 * variants. Pass `leftIcon` / `rightIcon` to decorate, or `onRemove` to turn
 * it into a dismissible chip (appends a trailing X button).
 */
const tagVariants = cva(
  [
    "inline-flex items-center gap-1 h-6 px-2 py-1 rounded-[6px] whitespace-nowrap select-none",
    "text-body-small-emphasised leading-none",
    "text-[color:var(--content-default)]",
  ].join(" "),
  {
    variants: {
      tone: {
        positive: "bg-[var(--system-positive-weak)]",
        negative: "bg-[var(--system-negative-weak)]",
        warning: "bg-[var(--system-mid-weak)]",
        info: "bg-[var(--system-info-weak)]",
        neutral: "bg-[var(--tag-bg-neutral)]",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

type TagVariantProps = VariantProps<typeof tagVariants>;

export type TagTone = NonNullable<TagVariantProps["tone"]>;

/**
 * Accent color per tone — used by the leading icon so the chip reads
 * quickly even when the background is desaturated. Pass a lucide icon via
 * `leftIcon`; we render it inline and color it via this token.
 */
const TONE_ICON_COLOR: Record<TagTone, string> = {
  positive: "var(--system-positive-strong)",
  negative: "var(--system-negative-strong)",
  warning: "var(--system-mid-strong)",
  info: "var(--system-info-strong)",
  neutral: "var(--content-secondary)",
};

export interface TagProps extends Omit<ComponentProps<"span">, "children"> {
  tone?: TagTone;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  /**
   * When provided, the tag renders a trailing X button whose click invokes
   * this handler. The button exposes an `aria-label` (customizable via
   * `removeLabel`) so assistive tech can announce it.
   */
  onRemove?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** Accessible label for the remove button. Defaults to "Remove". */
  removeLabel?: string;
  children?: ReactNode;
}

const iconStyle = {
  width: 12,
  height: 12,
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

export function Tag({
  tone = "neutral",
  leftIcon,
  rightIcon,
  onRemove,
  removeLabel = "Remove",
  className,
  children,
  ref,
  ...rest
}: TagProps) {
  const iconColor = TONE_ICON_COLOR[tone];
  return (
    <span
      {...rest}
      ref={ref}
      data-slot="tag"
      className={cn(tagVariants({ tone }), className)}
    >
      {leftIcon != null ? (
        <span
          aria-hidden="true"
          style={{ ...iconStyle, color: iconColor }}
        >
          {leftIcon}
        </span>
      ) : null}
      {children}
      {rightIcon != null && onRemove == null ? (
        <span
          aria-hidden="true"
          style={{ ...iconStyle, color: "var(--content-secondary)" }}
        >
          {rightIcon}
        </span>
      ) : null}
      {onRemove != null ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(event);
          }}
          className={cn(
            "inline-flex items-center justify-center rounded-full",
            "h-3.5 w-3.5 -mr-0.5 cursor-pointer",
            "text-[color:var(--content-secondary)]",
            "transition-colors duration-150",
            "hover:bg-[color-mix(in_srgb,currentColor_15%,transparent)]",
            "focus-visible:outline-none",
          )}
        >
          <X style={iconStyle} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

export { tagVariants };

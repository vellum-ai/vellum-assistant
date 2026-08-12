import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";
import { Typography } from "./typography";

export type NoticeTone = "info" | "success" | "warning" | "error" | "neutral";

export interface NoticeProps
  extends Omit<ComponentProps<"div">, "title" | "role"> {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  onDismiss?: () => void;
  actions?: ReactNode;
}

interface ToneClasses {
  container: string;
  icon: string;
  DefaultIcon: LucideIcon | null;
}

const TONE_CLASSES: Record<NoticeTone, ToneClasses> = {
  info: {
    container: "bg-[var(--surface-overlay)]",
    icon: "text-[color:var(--content-secondary)]",
    DefaultIcon: Info,
  },
  success: {
    container: "bg-[var(--system-positive-weak)]",
    icon: "text-[color:var(--system-positive-strong)]",
    DefaultIcon: CircleCheck,
  },
  warning: {
    container: "bg-[var(--system-mid-weak)]",
    icon: "text-[color:var(--system-mid-strong)]",
    DefaultIcon: CircleAlert,
  },
  error: {
    container: "bg-[var(--system-negative-weak)]",
    icon: "text-[color:var(--system-negative-strong)]",
    DefaultIcon: TriangleAlert,
  },
  neutral: {
    container: "bg-[var(--surface-overlay)]",
    icon: "text-[color:var(--content-secondary)]",
    DefaultIcon: null,
  },
};

export function Notice({
  tone = "info",
  title,
  children,
  icon,
  onDismiss,
  actions,
  className,
  ref,
  ...rest
}: NoticeProps) {
  const toneClasses = TONE_CLASSES[tone];
  const role = tone === "error" ? "alert" : "status";

  const resolvedIcon =
    icon === undefined
      ? toneClasses.DefaultIcon
        ? <toneClasses.DefaultIcon className="h-4 w-4" aria-hidden="true" />
        : null
      : icon;

  // Anything stacked under the icon (a title, or an actions row) reads as a
  // block the icon labels, so the icon aligns to the first line rather than to
  // the middle of the notice.
  const alignTop = Boolean(title || actions);

  return (
    <div
      {...rest}
      ref={ref}
      role={role}
      data-slot="notice"
      className={cn(
        "relative flex w-full gap-3 rounded-lg p-3",
        alignTop ? "items-start" : "items-center",
        "text-[color:var(--content-default)]",
        toneClasses.container,
        className,
      )}
    >
      {resolvedIcon ? (
        <span
          className={cn(
            "flex shrink-0 items-center justify-center",
            alignTop && "mt-0.5",
            toneClasses.icon,
          )}
        >
          {resolvedIcon}
        </span>
      ) : null}

      <div className="min-w-0 flex-1 space-y-1">
        {title ? (
          <Typography
            variant="body-medium-default"
            as="p"
            className="text-[color:var(--content-emphasised)]"
          >
            {title}
          </Typography>
        ) : null}
        {children ? (
          <Typography
            variant="body-medium-lighter"
            as="div"
            className="text-[color:var(--content-secondary)]"
          >
            {children}
          </Typography>
        ) : null}
        {/*
         * Actions sit under the message rather than beside it: a side column
         * competes with the text for width, which collapses the message to a
         * one-word-per-line column in narrow notices and strands the buttons
         * against dead space in wide ones.
         */}
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div>
        ) : null}
      </div>

      {/*
       * The dismiss control stays in the flow rather than being pinned to the
       * corner: reserving a corner lane means a root padding class, and `cn()`
       * merges the consumer's `className` last, so any caller passing its own
       * `p-*` would silently drop the reservation and let the button overlap
       * the message. At ~22px it costs the message almost nothing.
       */}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={cn(
            "shrink-0 cursor-pointer rounded bg-transparent p-0.5",
            "text-[color:var(--content-secondary)] opacity-70 transition-opacity",
            "hover:opacity-100 keyboard-focus:outline-none keyboard-focus:ring-2",
            "keyboard-focus:ring-[var(--ring)]",
          )}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

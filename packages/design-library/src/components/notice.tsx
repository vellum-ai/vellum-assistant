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
    container:
      "bg-[var(--surface-overlay)] border-[var(--border-element)]",
    icon: "text-[color:var(--content-secondary)]",
    DefaultIcon: Info,
  },
  success: {
    container:
      "bg-[var(--system-positive-weak)] border-[color-mix(in_srgb,var(--system-positive-strong)_25%,transparent)]",
    icon: "text-[color:var(--system-positive-strong)]",
    DefaultIcon: CircleCheck,
  },
  warning: {
    container:
      "bg-[var(--system-mid-weak)] border-[color-mix(in_srgb,var(--system-mid-strong)_30%,transparent)]",
    icon: "text-[color:var(--system-mid-strong)]",
    DefaultIcon: CircleAlert,
  },
  error: {
    container:
      "bg-[var(--system-negative-weak)] border-[color-mix(in_srgb,var(--system-negative-strong)_25%,transparent)]",
    icon: "text-[color:var(--system-negative-strong)]",
    DefaultIcon: TriangleAlert,
  },
  neutral: {
    container: "bg-[var(--surface-overlay)] border-[var(--border-base)]",
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
        "relative flex w-full gap-3 rounded-lg border p-3",
        alignTop ? "items-start" : "items-center",
        // The dismiss control is pinned to the corner, so reserve its lane.
        onDismiss && "pr-9",
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

      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={cn(
            "absolute right-2.5 top-2.5 cursor-pointer rounded bg-transparent p-0.5",
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

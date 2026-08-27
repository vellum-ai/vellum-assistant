import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

import { Tag, type TagTone } from "@vellumai/design-library";

import { cn } from "@/utils/misc";

/**
 * Full-surface empty state built as a first-run moment rather than a dead end.
 *
 * Three layers, top to bottom:
 * 1. `hero`: the assistant (avatar or icon well), a serif headline in the same
 *    voice as the chat greeting, and a one-line explanation of where content
 *    on this surface comes from.
 * 2. `preview`: a non-interactive ghost of the populated surface, so the user
 *    sees the shape of what they are about to create.
 * 3. `recipes` + actions: one-tap cards the assistant carries out, then a
 *    primary and a quiet secondary action.
 *
 * Every layer is optional so the compact variants (bell popover, sidebar
 * sections) can drop the preview and keep the recipes.
 */
export interface EmptyStateSceneProps {
  /** Avatar or icon well shown above the headline. */
  hero?: ReactNode;
  title: string;
  description: string;
  preview?: ReactNode;
  recipes?: ReactNode;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  /** `compact` tightens vertical rhythm for popovers and side panels. */
  density?: "page" | "compact";
  className?: string;
}

export function EmptyStateScene({
  hero,
  title,
  description,
  preview,
  recipes,
  primaryAction,
  secondaryAction,
  density = "page",
  className,
}: EmptyStateSceneProps) {
  const compact = density === "compact";
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center text-center",
        compact ? "gap-4 px-4 py-6" : "min-h-[400px] gap-6 px-4 py-16 sm:py-20",
        className,
      )}
    >
      <div className="flex flex-col items-center gap-3">
        {hero}
        <h2
          className={cn(
            "text-[var(--content-emphasised)] leading-[1.2] tracking-[0.02em]",
            compact ? "text-[22px]" : "text-[26px] md:text-[32px]",
          )}
          style={{ fontFamily: "var(--font-serif)" }}
        >
          {title}
        </h2>
        <p
          className={cn(
            "max-w-md text-[var(--content-tertiary)]",
            compact ? "text-body-small-lighter" : "text-body-medium-lighter",
          )}
        >
          {description}
        </p>
      </div>

      {preview ? <div className="w-full max-w-2xl">{preview}</div> : null}

      {recipes ? <div className="w-full max-w-2xl">{recipes}</div> : null}

      {primaryAction || secondaryAction ? (
        <div className="flex flex-col items-center gap-2">
          {primaryAction}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}

/** Rounded icon well, for surfaces that have no mascot moment. */
export function EmptyStateIconWell({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--surface-base)]">
      <Icon size={28} className="text-[var(--content-tertiary)]" />
    </div>
  );
}

/**
 * A ghost of the populated surface. Children render for real (the same row
 * components the live surface uses) but are inert and fade out at the bottom,
 * with a small "Example" tag so nobody mistakes them for data.
 */
export function EmptyStatePreview({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)} aria-hidden>
      <div className="absolute -top-3 left-3 z-10">
        <Tag tone="neutral">{label}</Tag>
      </div>
      <div
        className="pointer-events-none select-none rounded-xl border border-dashed border-[var(--border-base)] bg-[var(--surface-lift)] p-2 opacity-85 grayscale-[35%]"
        style={{
          maskImage:
            "linear-gradient(to bottom, black 60%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, black 60%, transparent 100%)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Grid wrapper for recipe cards: two-up on desktop, single column on mobile. */
export function EmptyStateRecipeGrid({
  children,
  columns = 2,
}: {
  children: ReactNode;
  columns?: 1 | 2 | 3;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 text-left",
        columns === 1 && "grid-cols-1",
        columns === 2 && "grid-cols-1 sm:grid-cols-2",
        columns === 3 && "grid-cols-1 sm:grid-cols-3",
      )}
    >
      {children}
    </div>
  );
}

/**
 * One-tap recipe. Selecting it hands a prompt to the assistant, which does the
 * work in a conversation (assistant-driven judgement, not a form). The card
 * shows the outcome the user gets, not the mechanism.
 */
export interface EmptyStateRecipeCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Optional trailing chip, e.g. a cadence ("Every weekday") or an effort hint. */
  meta?: string;
  metaTone?: TagTone;
  onSelect: () => void;
  disabled?: boolean;
}

export function EmptyStateRecipeCard({
  icon: Icon,
  title,
  description,
  meta,
  metaTone = "neutral",
  onSelect,
  disabled,
}: EmptyStateRecipeCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        "group flex w-full items-start gap-3 rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] p-3.5 text-left transition-colors",
        "hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-base)]">
        <Icon size={18} className="text-[var(--content-secondary)]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-body-medium-default text-[var(--content-default)]">
            {title}
          </span>
          {meta ? <Tag tone={metaTone}>{meta}</Tag> : null}
        </span>
        <span className="text-body-small-lighter text-[var(--content-tertiary)]">
          {description}
        </span>
      </div>
      <ArrowRight
        size={16}
        className="mt-2 shrink-0 text-[var(--content-faint)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--content-secondary)]"
      />
    </button>
  );
}

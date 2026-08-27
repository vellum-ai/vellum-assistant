import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

import { Tag } from "@vellumai/design-library";

import { cn } from "@/utils/misc";

/**
 * Empty state built as a first-run moment rather than a dead end.
 *
 * Two layers, top to bottom:
 * 1. `hero`: an icon well, and a serif headline in the same voice as the chat
 *    greeting.
 * 2. `recipes`: one-tap cards the assistant carries out.
 *
 * Both are optional, so a surface can lead with the headline alone.
 */
export interface EmptyStateSceneProps {
  /** Icon well shown above the headline. */
  hero?: ReactNode;
  title: string;
  recipes?: ReactNode;
}

export function EmptyStateScene({
  hero,
  title,
  recipes,
}: EmptyStateSceneProps) {
  return (
    <div className="flex h-full w-full flex-col items-center gap-4 px-4 py-6 text-center">
      <div className="flex flex-col items-center gap-3">
        {hero}
        <h2
          className="text-[22px] leading-[1.2] tracking-[0.02em] text-[var(--content-emphasised)]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          {title}
        </h2>
      </div>

      {recipes ? <div className="w-full max-w-2xl">{recipes}</div> : null}
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

/** Stacked wrapper for recipe cards. */
export function EmptyStateRecipeGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 text-left">{children}</div>;
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
  /** Optional trailing chip, e.g. a cadence ("Every weekday"). */
  meta?: string;
  onSelect: () => void;
}

export function EmptyStateRecipeCard({
  icon: Icon,
  title,
  description,
  meta,
  onSelect,
}: EmptyStateRecipeCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex w-full items-start gap-3 rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] p-3.5 text-left transition-colors",
        "hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
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
          {meta ? <Tag tone="neutral">{meta}</Tag> : null}
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

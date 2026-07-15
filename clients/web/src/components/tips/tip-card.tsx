/**
 * Presentational proactive tip card — props in, callbacks out. All gating,
 * selection, persistence, and telemetry live in `useTipCard`
 * (`hooks/use-tip-card.ts`); this component only renders the tip it is given.
 *
 * Compact promo-card layout for the narrow sidebar: eyebrow header row with
 * the dismiss X top-right, bold title, secondary body, then a footer row with
 * the learn-more CTA left and "Don't show again" right.
 */

import { Lightbulb, X } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { cn } from "@/utils/misc";
import { routes } from "@/utils/routes";
import type { Tip } from "@/utils/tips-catalog";

export interface TipCardProps {
  tip: Tip;
  onDismiss: () => void;
  onLearnMore: () => void;
  onDontShowAgain: () => void;
}

export function TipCard({
  tip,
  onDismiss,
  onLearnMore,
  onDontShowAgain,
}: TipCardProps) {
  const navigate = useNavigate();

  return (
    <div
      data-slot="tip-card"
      className="flex flex-col rounded-xl bg-[var(--system-info-weak)] px-3.5 py-3"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Lightbulb
          className="h-3.5 w-3.5 text-[color:var(--system-info-strong)]"
          aria-hidden="true"
        />
        <span className="text-[11px] font-semibold tracking-wider text-[color:var(--system-info-strong)] uppercase">
          {tip.eyebrow}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={cn(
            "-my-1 -mr-1 shrink-0 cursor-pointer rounded bg-transparent p-1",
            "text-[color:var(--content-tertiary)] transition-colors",
            "hover:text-[color:var(--content-secondary)]",
            "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:outline-none",
          )}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="mb-0.5 text-body-small-emphasised text-[color:var(--content-emphasised)]">
        {tip.title}
      </div>

      <div className="text-body-small-default leading-[1.45] text-[color:var(--content-secondary)]">
        {tip.body}
      </div>

      <div
        className={cn(
          "mt-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1",
          tip.learnMore ? "justify-between" : "justify-end",
        )}
      >
        {tip.learnMore ? (
          <Link
            data-slot="tip-card-learn-more"
            to={tip.learnMore.to}
            onClick={onLearnMore}
            className="text-body-small-default font-semibold whitespace-nowrap text-[color:var(--system-info-strong)] hover:underline"
          >
            {tip.learnMore.label} →
          </Link>
        ) : null}
        <button
          type="button"
          data-slot="tip-card-dont-show-again"
          onClick={() => {
            onDontShowAgain();
            navigate(routes.settings.general);
          }}
          className="cursor-pointer text-[10px] whitespace-nowrap text-[color:var(--content-tertiary)] hover:text-[color:var(--content-secondary)] hover:underline"
        >
          Don&apos;t show again
        </button>
      </div>
    </div>
  );
}

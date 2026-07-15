/**
 * Presentational proactive tip card — props in, callbacks out. All gating,
 * selection, persistence, and telemetry live in `useTipCard`
 * (`hooks/use-tip-card.ts`); this component only renders the tip it is given.
 *
 * Sized for the narrow sidebar: the Notice row wraps so the actions land on
 * their own line under the body instead of crushing it.
 */

import { Link, useNavigate } from "react-router";

import { Notice } from "@vellumai/design-library";

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
    <Notice
      tone="hint"
      onDismiss={onDismiss}
      className="flex-wrap gap-2 p-2.5"
      actions={
        <>
          {tip.learnMore ? (
            <Link
              data-slot="tip-card-learn-more"
              to={tip.learnMore.to}
              onClick={onLearnMore}
              className="text-body-small-default whitespace-nowrap text-[color:var(--content-secondary)] hover:text-[color:var(--content-emphasised)] hover:underline"
            >
              {tip.learnMore.label}
            </Link>
          ) : null}
          <button
            type="button"
            data-slot="tip-card-dont-show-again"
            onClick={() => {
              onDontShowAgain();
              navigate(routes.settings.general);
            }}
            className="text-body-small-default cursor-pointer whitespace-nowrap text-[color:var(--content-tertiary)] hover:text-[color:var(--content-secondary)] hover:underline"
          >
            Don&apos;t show again
          </button>
        </>
      }
    >
      {tip.body}
    </Notice>
  );
}

/**
 * Experimental "banner" placement for the proactive tip — renders the tip in
 * the composer banner slot with the same look as the app nudges. Mirrors
 * `NudgeChatBanner`'s markup (`components/nudges/nudge-chat-banner.tsx`)
 * instead of composing it because the CTA here is optional: not every tip
 * has a learn-more route. No "Don't show again" in this placement — the
 * dismiss X covers the demo.
 */

import { ChevronRight, Lightbulb, X } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@vellumai/design-library";

import type { Tip } from "@/utils/tips-catalog";

export interface TipChatBannerProps {
  tip: Tip;
  onDismiss: () => void;
  onLearnMore: () => void;
  /** Dev/demo-only cycler — omitted in production, so no button renders. */
  onNextTip?: () => void;
}

export function TipChatBanner({
  tip,
  onDismiss,
  onLearnMore,
  onNextTip,
}: TipChatBannerProps) {
  const navigate = useNavigate();
  const learnMore = tip.learnMore;

  return (
    <div
      data-slot="tip-chat-banner"
      className="mx-auto flex overflow-hidden rounded-xl border"
      style={{
        background: "var(--surface-base)",
        borderColor: "var(--border-element)",
        animation: "fadeInUp 0.25s ease-out both",
        maxWidth: "var(--chat-max-width)",
        width: "100%",
        boxShadow: "0 2px 8px rgba(0,0,0,0.08), 0 4px 16px rgba(0,0,0,0.06)",
      }}
      role="status"
      aria-label={`Tip: ${tip.title}`}
    >
      <div className="flex flex-1 items-center gap-2 px-4 py-3 md:gap-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "var(--surface-lift)" }}
        >
          <Lightbulb
            size={16}
            className="text-[color:var(--system-info-strong)]"
            aria-hidden="true"
          />
        </span>

        <div className="min-w-0 flex-1">
          <p
            className="text-body-medium-default leading-tight"
            style={{ color: "var(--content-default)" }}
          >
            {tip.title}
          </p>
          <p
            className="text-label-medium-default md:text-label-small-default mt-0.5"
            style={{ color: "var(--content-tertiary)" }}
          >
            {tip.body}
          </p>
        </div>

        {learnMore ? (
          <Button
            variant="primary"
            size="regular"
            onClick={() => {
              onLearnMore();
              void navigate(learnMore.to);
            }}
            aria-label={learnMore.label}
          >
            {learnMore.label}
          </Button>
        ) : null}

        {onNextTip ? (
          <Button
            variant="ghost"
            size="regular"
            iconOnly={<ChevronRight />}
            onClick={onNextTip}
            aria-label="Next tip"
          />
        ) : null}

        <Button
          className="ml-1 md:ml-0"
          variant="ghost"
          size="regular"
          iconOnly={<X />}
          onClick={onDismiss}
          aria-label="Dismiss"
        />
      </div>
    </div>
  );
}

/**
 * The minimized checklist (Figma: New-App `8300:167083`).
 *
 * What is left of the modal once it has been put off: the mascot cluster
 * hanging off the pill's left edge, the word "Suggestions", and how many of
 * the three starters are done. Clicking it brings the modal back.
 *
 * There is deliberately no dismiss control. The pill is already the dismissed
 * state, and it retires itself the moment the third starter finishes, so a
 * second way to hide it would only make the checklist unreachable.
 *
 * Under 480px the word goes and the mascots plus the count stay (PLAN A7):
 * the top bar has a search control and a notification bell beside it, and the
 * count is the part that carries information.
 */

import type { ReactNode } from "react";

import { cn, Typography } from "@vellumai/design-library";

import { ChatPill } from "@/components/chat-pill";
import { useTranslation } from "@/i18n";
import { publicAsset } from "@/utils/public-asset";

export interface ActivationSuggestionsPillProps {
  /** Starters the daemon has marked done. */
  done: number;
  /** Starters in the list, which is three today. */
  total: number;
  onClick: () => void;
  className?: string;
}

export function ActivationSuggestionsPill({
  done,
  total,
  onClick,
  className,
}: ActivationSuggestionsPillProps): ReactNode {
  const { t } = useTranslation("activation");

  return (
    <ChatPill
      size="compact"
      tone="default"
      onClick={onClick}
      ariaLabel={t("pill.aria", { done, total })}
      className={cn("h-8 gap-1 overflow-hidden pl-0", className)}
    >
      {/* Bleeds past the pill's left inset so the cluster is cut by the
          rounded edge, as in the mock. */}
      <img
        src={publicAsset("/activation-pill-mascots.svg")}
        alt=""
        aria-hidden="true"
        width={40}
        height={32}
        className="h-8 w-10 shrink-0"
      />
      <Typography
        as="span"
        variant="body-small-emphasised"
        className="text-[var(--content-default)] max-[479px]:hidden"
      >
        {t("pill.label")}
      </Typography>
      {/* The dot separates two things, so it goes when one of them does. */}
      <span
        aria-hidden="true"
        className="h-[2px] w-[2px] shrink-0 rounded-full bg-[var(--content-tertiary)] max-[479px]:hidden"
      />
      <Typography
        as="span"
        variant="body-small-default"
        className="pr-1 text-[var(--content-tertiary)]"
      >
        {t("pill.progress", { done, total })}
      </Typography>
    </ChatPill>
  );
}

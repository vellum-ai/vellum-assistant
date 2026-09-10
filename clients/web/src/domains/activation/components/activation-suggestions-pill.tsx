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
 * Under 480px the word goes and the mascots plus the count stay:
 * the top bar has a search control and a notification bell beside it, and the
 * count is the part that carries information.
 */

import type { ReactNode } from "react";

import { cn, Typography } from "@vellumai/design-library";

import { ChatPill } from "@/components/chat-pill";
import { MidlineDot } from "@/components/midline-dot";
import { useTranslation } from "@/i18n";
import { emitActivationEvent } from "@/utils/activation-telemetry";
import { publicAsset } from "@/utils/public-asset";

import { useActivationUiStore } from "../activation-ui-store";
import { getActivationListIds } from "../catalog";
import { useActivationProgress } from "../hooks/use-activation-progress";
import {
  doneStarterCount,
  useActivationVisibility,
} from "../hooks/use-activation-visibility";

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
      <MidlineDot className="size-[2px] max-[479px]:hidden" />
      {/* Secondary rather than tertiary: at 12px the tertiary ink misses AA on
          the pill's ground, and on a phone this count is the whole label. */}
      <Typography
        as="span"
        variant="body-small-default"
        className="pr-1 text-[var(--content-secondary)]"
      >
        {t("pill.progress", { done, total })}
      </Typography>
    </ChatPill>
  );
}

/**
 * The suggestions pill, wired to the checklist's gate stack.
 *
 * Passed to the chat layout header as its `topBarPill`, a slot of its own that
 * the header seats ahead of the route's own accessory. Registering the pill
 * through `setTopBarRightSlot` instead would erase whatever the chat page's
 * header registration had put there, since that slot has a single writer and
 * is rewritten on every conversation change.
 *
 * Shows only while the checklist is in its dismissed-but-unfinished state, so
 * it retires itself once the third starter lands.
 */
export function ActivationSuggestionsPillHost(): ReactNode {
  const { surface, listId } = useActivationVisibility();
  const { data: progress } = useActivationProgress();
  const openModal = useActivationUiStore.use.openModal();

  if (surface !== "pill" || listId === null || !progress) {
    return null;
  }

  return (
    <ActivationSuggestionsPill
      done={doneStarterCount(progress, listId)}
      total={getActivationListIds(listId).starters.length}
      onClick={() => {
        emitActivationEvent("activation_pill_clicked");
        openModal();
      }}
    />
  );
}

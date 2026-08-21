// Collapsed subagent summary: capped avatar badges + "+N" overflow chip + a
// "Details" toggle. Figma nodes 6063:148533 (few) / 6063:148462 (many).

import { ChevronDown } from "lucide-react";

import { SubagentAvatarBadge } from "@/components/avatar/subagent-avatar-badge";
import { Typography } from "@vellumai/design-library";

import { MAX_VISIBLE_STACKED_CHIPS } from "@/domains/chat/process-registry/constants";
import { useTranslation } from "@/i18n";

// Visible-avatar cap before the "+N" overflow chip. Aliases the shared
// stacked-chips cap so the avatar row and the overlay pills share one source of
// truth.
export const MAX_VISIBLE_SUBAGENT_AVATARS = MAX_VISIBLE_STACKED_CHIPS;

export interface SubagentAvatarRowProps {
  subagentIds: string[];
  onExpand: () => void;
}

export function SubagentAvatarRow({
  subagentIds,
  onExpand,
}: SubagentAvatarRowProps) {
  const { t } = useTranslation("chat");
  const overflowCount = subagentIds.length - MAX_VISIBLE_SUBAGENT_AVATARS;

  // The row wraps because it can outgrow the transcript column. At the
  // six-avatar cap the badges, the overflow chip, and the Details label need
  // about 416px, more than every phone in portrait leaves after the
  // transcript's px-4 (a 430px viewport leaves ~398px), and more than a narrow
  // transcript leaves on desktop once the detail panel is dragged out to
  // `minLeftWidth` (`chat-content-layout.tsx`). The transcript wrapper is
  // `contain-content`, so an unwrapped row loses the Details affordance to
  // clipping rather than overflowing visibly.
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={t("subagentAvatarRow.showDetailsAria")}
      data-testid="subagent-avatar-row-details"
      className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-2"
    >
      {/* pointer-events-none so clicking an avatar triggers the button, not the avatar. */}
      <div className="pointer-events-none flex flex-wrap items-center gap-1">
        {subagentIds.slice(0, MAX_VISIBLE_SUBAGENT_AVATARS).map((id) => (
          <SubagentAvatarBadge key={id} subagentId={id} />
        ))}

        {/* Carries the badges' own footprint, including their mixed-unit
            width, so the row reads as one family at any root font size. */}
        {overflowCount > 0 && (
          <div
            data-testid="subagent-avatar-row-overflow"
            className="flex h-8 w-[calc(1rem+30px)] items-center justify-center rounded-full bg-[var(--surface-active)]"
          >
            <Typography
              variant="body-small-default"
              className="text-[var(--content-emphasised)]"
            >
              +{overflowCount}
            </Typography>
          </div>
        )}
      </div>

      {/* Text style tracks the chat transcript's "Thinking" label
          (single-activity.tsx): 13px / 500 / --content-secondary. Off the
          typography scale, so it can't use a `Typography` variant. */}
      <span className="flex items-center gap-1 text-[13px] font-medium text-[var(--content-secondary)]">
        {t("subagentAvatarRow.details")}
        <ChevronDown className="h-3 w-3 text-[var(--content-tertiary)]" />
      </span>
    </button>
  );
}

// Collapsed subagent summary: capped avatar badges + "+N" overflow chip + a
// "Details" toggle. Figma nodes 6063:148533 (few) / 6063:148462 (many).

import { ChevronDown } from "lucide-react";

import { SubagentAvatarBadge } from "@/components/avatar/subagent-avatar-badge";
import { Typography } from "@vellumai/design-library";

import { MAX_VISIBLE_STACKED_CHIPS } from "@/domains/chat/process-registry/constants";

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
  const overflowCount = subagentIds.length - MAX_VISIBLE_SUBAGENT_AVATARS;

  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Show subagent details"
      data-testid="subagent-avatar-row-details"
      className="flex cursor-pointer items-center gap-3"
    >
      {/* pointer-events-none so clicking an avatar triggers the button, not the avatar. */}
      <div className="pointer-events-none flex items-center gap-1">
        {subagentIds
          .slice(0, MAX_VISIBLE_SUBAGENT_AVATARS)
          .map((id) => (
            <SubagentAvatarBadge key={id} subagentId={id} />
          ))}

        {overflowCount > 0 && (
          <div
            data-testid="subagent-avatar-row-overflow"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-active)]"
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

      <span className="flex items-center gap-1">
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-tertiary)]"
        >
          Details
        </Typography>
        <ChevronDown className="h-3 w-3 text-[var(--content-tertiary)]" />
      </span>
    </button>
  );
}

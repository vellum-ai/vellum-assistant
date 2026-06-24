/**
 * Collapsed subagent summary (Figma nodes `6063:148533` few / `6063:148462`
 * many).
 *
 * Renders a capped row of `SubagentAvatarBadge`s for a set of spawned
 * subagents, an overflow `+N` chip when the count exceeds the visible cap,
 * and a "Details" toggle that expands into the full per-subagent view.
 */

import { ChevronDown } from "lucide-react";

import { SubagentAvatarBadge } from "@/components/avatar/subagent-avatar-badge";
import { Typography } from "@vellumai/design-library";

/**
 * Number of subagent avatars shown before collapsing the remainder into a
 * `+N` overflow chip. The mock (`6063:148462`) shows 6 avatars followed by a
 * "+6" chip; the requester's "more than 4" phrasing maps onto this tunable
 * cap rather than a hardcoded literal.
 */
export const MAX_VISIBLE_SUBAGENT_AVATARS = 6;

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
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1">
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

      <button
        type="button"
        onClick={onExpand}
        aria-label="Show subagent details"
        data-testid="subagent-avatar-row-details"
        className="flex items-center gap-1"
      >
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-tertiary)]"
        >
          Details
        </Typography>
        <ChevronDown className="h-3 w-3 text-[var(--content-tertiary)]" />
      </button>
    </div>
  );
}

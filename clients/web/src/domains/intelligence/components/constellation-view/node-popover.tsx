
import { FileText, Zap } from "lucide-react";

import type { OrbitItem } from "@/domains/intelligence/components/constellation-layout";
import { SkillIcon } from "@/domains/intelligence/components/skills/skill-icon";
import { Button, Card } from "@vellumai/design-library";

export interface NodePopoverProps {
  item: OrbitItem;
  color: string;
  onViewDetails?: () => void;
}

export function NodePopover({ item, color, onViewDetails }: NodePopoverProps) {
  const typeLabel = item.kind === "skill" ? "Skill" : "Workspace";
  const TypeIcon = item.kind === "skill" ? Zap : FileText;
  return (
    <Card
      padding="sm"
      elevated
      className="w-[260px] shadow-[var(--shadow-popover)]"
      role="dialog"
      aria-label={`${item.label} details`}
    >
      <div className="flex items-center justify-between gap-2">
        {/* TODO: Category chip uses a dynamic per-item color that can't be
            expressed through Tag's 4 fixed tones. Leaving as a bespoke span. */}
        <span
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-body-small-emphasised text-[var(--content-default)]"
          style={{ backgroundColor: `${color}33` }}
        >
          <TypeIcon className="h-3 w-3" style={{ color }} />
          {typeLabel}
        </span>
        {onViewDetails ? (
          <Button
            type="button"
            variant="ghost"
            size="compact"
            onClick={onViewDetails}
          >
            View Details
          </Button>
        ) : null}
      </div>
      <div className="mt-2 flex items-start gap-2">
        {(item.icon || item.emoji) ? (
          <SkillIcon skill={item} className="h-5 w-5 shrink-0 text-[20px] leading-none" />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-body-medium-default text-[var(--content-default)]">
            {item.label}
          </div>
          {item.description ? (
            <div className="mt-1 line-clamp-3 text-body-small-default text-[var(--content-secondary)]">
              {item.description}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

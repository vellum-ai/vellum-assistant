import { ArrowDownToLine, Loader2, Trash2 } from "lucide-react";
import type { KeyboardEvent } from "react";

import { SkillIcon } from "@/domains/intelligence/components/skills/skill-icon";
import { SkillOriginBadge } from "@/domains/intelligence/components/skills/skill-origin-badge";
import {
    isAvailableSkill,
    type SkillInfo,
} from "@/domains/intelligence/skills/types";
import { isRemovableSkill } from "@/utils/skills";
import { Button, Card } from "@vellumai/design-library";

interface SkillRowProps {
  skill: SkillInfo;
  onSelect: () => void;
  onInstall?: () => void;
  onRemove?: () => void;
  isInstalling?: boolean;
  isRemoving?: boolean;
}

export function SkillRow({
  skill,
  onSelect,
  onInstall,
  onRemove,
  isInstalling = false,
  isRemoving = false,
}: SkillRowProps) {
  const available = isAvailableSkill(skill);
  const removable = isRemovableSkill(skill);

  const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <Card.Root asChild>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={handleRowKeyDown}
        className="flex cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
      <div className="flex shrink-0 items-center justify-center text-[28px] leading-none">
        <SkillIcon skill={skill} className="h-7 w-7" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-body-medium-default"
            style={{ color: "var(--content-emphasised)" }}
          >
            {skill.name}
          </span>
          <SkillOriginBadge origin={skill.origin} />
        </div>
        <p
          className="mt-1 truncate text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          {skill.description}
        </p>
      </div>

      {available ? (
        isInstalling ? (
          <Button
            type="button"
            iconOnly={<Loader2 className="animate-spin" aria-hidden />}
            disabled
            aria-label="Installing"
            expandOnMobile={false}
          />
        ) : (
          <Button
            type="button"
            iconOnly={<ArrowDownToLine aria-hidden />}
            onClick={(e) => {
              e.stopPropagation();
              onInstall?.();
            }}
            disabled={!onInstall}
            aria-label="Install skill"
            expandOnMobile={false}
          />
        )
      ) : (
        <Button
          type="button"
          variant="dangerOutline"
          iconOnly={
            isRemoving ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Trash2 aria-hidden />
            )
          }
          onClick={(e) => {
            e.stopPropagation();
            onRemove?.();
          }}
          disabled={!removable || isRemoving || !onRemove}
          aria-label={removable ? "Remove skill" : "Bundled skill cannot be removed"}
          title={removable ? undefined : "Bundled skills cannot be removed"}
          expandOnMobile={false}
        />
      )}
      </div>
    </Card.Root>
  );
}

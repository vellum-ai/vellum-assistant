import { ArrowDownToLine, Loader2, Trash2 } from "lucide-react";
import type { KeyboardEvent } from "react";

import { Button, Card } from "@vellum/design-library";
import { SkillOriginBadge } from "@/domains/intelligence/components/skills/skill-origin-badge";
import {
  isAvailableSkill,
  isRemovableSkill,
  type SkillInfo,
} from "@/domains/intelligence/skills/types";

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
        className="flex cursor-pointer items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center text-2xl">
        {skill.emoji ?? "🧩"}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {skill.name}
          </span>
          <SkillOriginBadge origin={skill.origin} />
        </div>
        <p
          className="mt-1 truncate text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          {skill.description}
        </p>
      </div>

      {available ? (
        isInstalling ? (
          <div className="flex h-9 items-center px-3" aria-label="Installing">
            <Loader2
              className="h-4 w-4 animate-spin"
              style={{ color: "var(--content-tertiary)" }}
            />
          </div>
        ) : (
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onInstall?.();
            }}
            disabled={!onInstall}
            leftIcon={<ArrowDownToLine aria-hidden />}
          >
            Install
          </Button>
        )
      ) : (
        <Button
          type="button"
          variant={removable ? "dangerOutline" : "outlined"}
          onClick={(e) => {
            e.stopPropagation();
            onRemove?.();
          }}
          disabled={!removable || isRemoving || !onRemove}
          aria-label={removable ? "Remove skill" : "Bundled skill cannot be removed"}
          title={removable ? undefined : "Bundled skills cannot be removed"}
          leftIcon={
            isRemoving ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Trash2 aria-hidden />
            )
          }
        >
          Remove
        </Button>
      )}
      </div>
    </Card.Root>
  );
}

import { Brain } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@vellumai/design-library";
import type { Surface } from "@/domains/chat/types/types";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import {
  filterRecords,
  str,
} from "@/domains/chat/components/surfaces/surface-parse-helpers";
import { routes } from "@/utils/routes";

/**
 * Card copy lives here as the single source so a design copy swap is a
 * one-line change. The subline is static because the card can arrive long
 * after the triggering work (the retrospective runs in the background).
 */
const SKILL_CARD_FALLBACK_TITLE = "New skill learned";
const SKILL_CARD_SUBLINE = "Saved to your skills from this conversation's work";

interface SkillCardEntry {
  skillId: string;
  name: string;
  description?: string;
  emoji?: string;
}

interface SkillCreatedCardProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
}

/**
 * Narrow the untyped `data.skills` payload to renderable entries. Entries
 * missing a usable `skillId` or `name` are dropped rather than crashing the
 * card; a malformed or absent list yields `[]` (the card renders nothing).
 */
function parseSkills(skills: unknown): SkillCardEntry[] {
  return filterRecords(skills).flatMap((entry) => {
    const skillId = str(entry.skillId);
    const name = str(entry.name);
    if (!skillId || !name) {
      return [];
    }
    return [
      {
        skillId,
        name,
        description: str(entry.description),
        emoji: str(entry.emoji),
      },
    ];
  });
}

/**
 * Static in-chat card announcing skills the memory retrospective authored
 * from this conversation's work. One card batches all skills from a single
 * retrospective run as stacked rows; each row deep-links to the skill.
 */
export function SkillCreatedCard({ surface, onAction }: SkillCreatedCardProps) {
  const navigate = useNavigate();
  const skills = parseSkills(surface.data.skills);

  // Single navigation target for every row so a later change (e.g. an
  // in-chat skill detail sidepanel) rewires the card in one place.
  const handleView = (skillId: string) => {
    navigate(`${routes.skills}?skill=${encodeURIComponent(skillId)}`);
  };

  if (skills.length === 0) {
    return null;
  }

  return (
    <SurfaceContainer surface={surface} onAction={onAction} hideTitle>
      <h3 className="text-title-small text-[var(--content-strong)]">
        {surface.title ?? SKILL_CARD_FALLBACK_TITLE}
      </h3>
      <p className="mt-0.5 text-body-small-default text-[var(--content-quiet)]">
        {SKILL_CARD_SUBLINE}
      </p>

      <div className="mt-3 divide-y divide-[var(--border-base)]">
        {skills.map((skill) => (
          <div
            key={skill.skillId}
            className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--tag-bg-neutral)] text-body-large-default">
              {skill.emoji ?? (
                <Brain className="h-4 w-4 text-[var(--content-tertiary)]" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-body-medium-default text-[var(--content-strong)]">
                {skill.name}
              </div>
              {skill.description && (
                <p className="truncate text-body-small-default text-[var(--content-tertiary)]">
                  {skill.description}
                </p>
              )}
            </div>
            <Button
              variant="outlined"
              size="compact"
              onClick={() => handleView(skill.skillId)}
            >
              View
            </Button>
          </div>
        ))}
      </div>
    </SurfaceContainer>
  );
}

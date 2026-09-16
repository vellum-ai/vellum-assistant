import { Brain } from "lucide-react";

import type { Surface } from "@/domains/chat/types/types";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import {
  filterRecords,
  str,
} from "@/domains/chat/components/surfaces/surface-parse-helpers";

/**
 * Card copy lives here as the single source so a design copy swap is a
 * one-line change. Each skill renders as a single row whose title is the
 * full "I just learned…" sentence (no generic card header): the card should
 * read like the assistant sharing what it picked up, not like a technical
 * "skill created" notice.
 */
const skillRowTitle = (name: string) => `I just learned how to do ${name}`;

interface SkillCardEntry {
  skillId: string;
  name: string;
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
      },
    ];
  });
}

/**
 * Static in-chat card announcing skills the memory retrospective authored
 * from this conversation's work. One card batches all skills from a single
 * retrospective run as stacked rows.
 */
export function SkillCreatedCard({ surface, onAction }: SkillCreatedCardProps) {
  const skills = parseSkills(surface.data.skills);

  if (skills.length === 0) {
    return null;
  }

  return (
    <SurfaceContainer
      surface={surface}
      onAction={onAction}
      hideTitle
      className="px-3 py-2"
    >
      <div className="divide-y divide-[var(--border-base)]">
        {skills.map((skill) => (
          <div
            key={skill.skillId}
            className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--tag-bg-neutral)] text-body-large-default">
              <Brain className="h-4 w-4 text-[var(--content-tertiary)]" />
            </span>
            <div className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-strong)]">
              {skillRowTitle(skill.name)}
            </div>
          </div>
        ))}
      </div>
    </SurfaceContainer>
  );
}

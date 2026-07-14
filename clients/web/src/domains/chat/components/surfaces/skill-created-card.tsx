import { Brain } from "lucide-react";
import { useNavigate } from "react-router";

import type { Surface } from "@/domains/chat/types/types";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import {
  filterRecords,
  str,
} from "@/domains/chat/components/surfaces/surface-parse-helpers";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

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
  const isMobile = useIsMobile();
  const skills = parseSkills(surface.data.skills);

  // Desktop: open the skill detail sidepanel in place, keeping the
  // conversation visible. Mobile: side panels don't render on narrow
  // viewports (mirroring the channel-setup hand-off in
  // chat-content-layout.tsx), so deep-link to the dedicated detail page.
  const handleView = (skillId: string) => {
    if (isMobile) {
      navigate(routes.skills.detail(skillId));
      return;
    }
    useViewerStore.getState().openSkillDetail(skillId);
  };

  if (skills.length === 0) {
    return null;
  }

  return (
    <SurfaceContainer surface={surface} onAction={onAction} hideTitle>
      <div className="divide-y divide-[var(--border-base)]">
        {/* The whole row is one native button (name, description, and the
            "View" chip all open the skill) — matching the clickable-row
            pattern in home-schedule-row.tsx. The chip is purely visual, so
            no nested interactive elements and no stopPropagation dance;
            `aria-label` keeps the accessible name unique per skill. */}
        {skills.map((skill) => (
          <button
            key={skill.skillId}
            type="button"
            aria-label={`View ${skill.name}`}
            onClick={() => handleView(skill.skillId)}
            className="flex w-full cursor-pointer items-center gap-3 rounded-md py-2.5 text-left transition-colors first:pt-0 last:pb-0 hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--tag-bg-neutral)] text-body-large-default">
              {skill.emoji ?? (
                <Brain className="h-4 w-4 text-[var(--content-tertiary)]" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-body-medium-default text-[var(--content-strong)]">
                {skillRowTitle(skill.name)}
              </div>
              {skill.description && (
                <p className="truncate text-body-small-default text-[var(--content-tertiary)]">
                  {skill.description}
                </p>
              )}
            </div>
            <span
              aria-hidden="true"
              className="flex h-6 shrink-0 items-center rounded-md border border-[var(--border-element)] px-2 text-label-medium-default text-[var(--primary-base)]"
            >
              View
            </span>
          </button>
        ))}
      </div>
    </SurfaceContainer>
  );
}

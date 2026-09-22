/**
 * The "Used Skill" card at the head of a `skill_load` detail panel (Figma node
 * 7778-163402): the skill's own glyph, its name and one-line description, and a
 * View action that opens the full skill detail in the same drawer. It is
 * drawn like every card that names what a call was about, the web fetch
 * source card included: a bordered `CardRoot` on the overlay surface.
 *
 * The glyph and the display name are the skill's real identity, so the card
 * reads the skill record from the daemon rather than inventing a generic icon.
 * That query is best-effort: the load result already carries a name and
 * description, so a skill the daemon can't resolve (removed since, or no
 * assistant in context) degrades to the puzzle-piece fallback instead of an
 * error state.
 */

import { useQuery } from "@tanstack/react-query";

import { Button, CardRoot, Typography } from "@vellumai/design-library";

import { SkillIcon } from "@/components/skill-icon";
import { skillsByIdGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useViewerStore } from "@/stores/viewer-store";
import { useTranslation } from "@/i18n";

export function SkillLoadCard({
  skillId,
  name,
  /** Description from the load result, or the load status while it's absent. */
  secondary,
  assistantId,
}: {
  skillId: string;
  name: string;
  secondary: string;
  assistantId?: string | null;
}) {
  const { t } = useTranslation("chat");
  const openSkillDetail = useViewerStore.use.openSkillDetail();

  const { data: skill } = useQuery({
    ...skillsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: skillId },
    }),
    select: (data) => data.skill,
    enabled: Boolean(assistantId && skillId),
  });

  return (
    <CardRoot
      surface="overlay"
      padding="sm"
      className="flex items-center gap-4"
    >
      <SkillIcon
        skill={skill ?? { id: skillId }}
        className="h-8 w-8 shrink-0 text-[32px] leading-none"
      />
      <div className="min-w-0 flex-1">
        <Typography
          variant="title-small"
          as="div"
          className="leading-snug text-[var(--content-emphasised)]"
        >
          {name}
        </Typography>
        {secondary && (
          <Typography
            variant="body-medium-lighter"
            as="p"
            className="mt-1 text-[var(--content-tertiary)]"
          >
            {secondary}
          </Typography>
        )}
      </div>
      {skillId && (
        <Button
          variant="outlined"
          onClick={() => openSkillDetail(skillId)}
          className="shrink-0"
        >
          {t("skillLoadCard.view")}
        </Button>
      )}
    </CardRoot>
  );
}

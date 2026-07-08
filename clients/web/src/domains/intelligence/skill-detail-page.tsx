import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, SearchX } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { SkillDetail } from "@/domains/intelligence/components/skills/skill-detail";
import { SkillDetailMobile } from "@/domains/intelligence/components/skills/skill-detail-mobile";
import { SkillRemovalDialog } from "@/domains/intelligence/components/skills/skill-removal-dialog";
import { SkillsErrorState } from "@/domains/intelligence/components/skills/skills-error-state";
import { SkillsLoadingState } from "@/domains/intelligence/components/skills/skills-loading-state";
import { SkillsStateCard } from "@/domains/intelligence/components/skills/skills-state-card";
import { type SkillInfo } from "@/domains/intelligence/skills/types";
import { useSkillActions } from "@/domains/intelligence/skills/use-skill-actions";
import { skillsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library";

/**
 * Dedicated page for a single skill at `/assistant/skills/:skillId`.
 *
 * Resolves the skill from the same catalog list query the Skills tab uses
 * (cache-shared, so navigating from the list renders instantly) and renders
 * the existing `SkillDetail` / `SkillDetailMobile` views. Removing the skill
 * navigates back to the list.
 */
export function SkillDetailPage() {
  const assistantId = useActiveAssistantId();
  const { skillId } = useParams<{ skillId: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const skillsQuery = useQuery({
    ...skillsGetOptions({
      path: { assistant_id: assistantId },
      query: { include: "catalog" },
    }),
    select: (data): SkillInfo[] => data.skills,
  });

  const handleBack = useCallback(() => {
    // Replace (rather than push) so browser Back doesn't bounce the user
    // back to the detail entry — which may be a not-found page after the
    // skill was removed via `onRemoved`.
    navigate(routes.skills.root, { replace: true });
  }, [navigate]);

  const {
    handleInstall,
    handleRemove,
    isInstallingSkill,
    isRemovingSkill,
    skillPendingRemoval,
    confirmRemove,
    cancelRemove,
  } = useSkillActions(assistantId, { onRemoved: handleBack });

  const skills = skillsQuery.data;
  const skill = useMemo(
    () => skills?.find((s) => s.id === skillId) ?? null,
    [skills, skillId],
  );

  if (!skillId) {
    return <Navigate to={routes.skills.root} replace />;
  }

  if (skillsQuery.isLoading) {
    return <SkillsLoadingState />;
  }

  if (skillsQuery.isError) {
    return <SkillsErrorState />;
  }

  if (!skill) {
    return (
      <SkillsStateCard
        icon={SearchX}
        title="Skill not found"
        subtitle="This skill may have been removed, or the link is out of date."
      >
        <Button
          type="button"
          variant="outlined"
          className="mt-4"
          leftIcon={<ArrowLeft aria-hidden />}
          onClick={handleBack}
        >
          Back to skills
        </Button>
      </SkillsStateCard>
    );
  }

  const detailProps = {
    assistantId,
    skill,
    onBack: handleBack,
    onInstall: () => handleInstall(skill),
    onRemove: () => handleRemove(skill),
    isInstalling: isInstallingSkill(skill),
    isRemoving: isRemovingSkill(skill),
  };

  return (
    <>
      {isMobile ? (
        <SkillDetailMobile {...detailProps} />
      ) : (
        <SkillDetail {...detailProps} />
      )}
      <SkillRemovalDialog
        skill={skillPendingRemoval}
        onConfirm={confirmRemove}
        onCancel={cancelRemove}
      />
    </>
  );
}

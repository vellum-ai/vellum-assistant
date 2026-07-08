import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, SearchX } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { SkillDetail } from "@/domains/intelligence/components/skills/skill-detail";
import { SkillDetailMobile } from "@/domains/intelligence/components/skills/skill-detail-mobile";
import { SkillRemovalDialog } from "@/domains/intelligence/components/skills/skill-removal-dialog";
import { SkillsErrorState } from "@/domains/intelligence/components/skills/skills-error-state";
import { SkillsLoadingState } from "@/domains/intelligence/components/skills/skills-loading-state";
import { SkillsStateCard } from "@/domains/intelligence/components/skills/skills-state-card";
import { type SkillInfo } from "@/domains/intelligence/skills/types";
import { useSkillActions } from "@/domains/intelligence/skills/use-skill-actions";
import {
  skillsByIdGetOptions,
  skillsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useEdgeSwipeBack } from "@/hooks/use-edge-swipe-back";
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
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const swipeContainerRef = useRef<HTMLDivElement>(null);

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

  // Register as the mobile back-swipe owner so a left-edge swipe navigates
  // back to the skills list instead of opening the nav drawer (`ChatLayout`
  // only yields the edge while an owner is registered). The container ref is
  // threaded into `SkillDetailMobile`'s portaled overlay root — a page-level
  // wrapper wouldn't contain the overlay's DOM, so the drag transform would
  // move nothing. On the loading/error/not-found branches the ref is
  // unattached and a committed swipe still resolves to `handleBack` (see
  // `useEdgeSwipeBack`'s null-container commit path).
  useEdgeSwipeBack({
    containerRef: swipeContainerRef,
    onBack: handleBack,
    enabled: isMobile,
    navKey: pathname,
  });

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

  // Conversation lineage lives only on the single-skill detail response, not
  // the list the page resolves from — fetch it lazily, and only for
  // retrospective-authored skills (the only origin that can carry it).
  const lineageQuery = useQuery({
    ...skillsByIdGetOptions({
      path: { assistant_id: assistantId, id: skillId ?? "" },
    }),
    enabled: Boolean(skillId) && skill?.origin === "assistant-memory",
    select: (data) =>
      data.skill.origin === "assistant-memory"
        ? (data.skill.sourceConversationId ?? null)
        : null,
  });

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
    sourceConversationId: lineageQuery.data ?? undefined,
  };

  return (
    <>
      {isMobile ? (
        <SkillDetailMobile
          {...detailProps}
          swipeContainerRef={swipeContainerRef}
        />
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

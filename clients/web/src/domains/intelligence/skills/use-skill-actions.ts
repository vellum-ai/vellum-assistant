import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { useSkillsByIdDeleteMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { invalidateSkillsList } from "@/utils/skills";

import { installSkill } from "./install";
import { type SkillInfo } from "./types";

interface UseSkillActionsOptions {
  /** Called after a removal succeeds (e.g. navigate away from a detail page). */
  onRemoved?: () => void;
}

interface UseSkillActionsResult {
  handleInstall: (skill: SkillInfo) => void;
  /** Stages `skill` for removal — confirm via `confirmRemove`. */
  handleRemove: (skill: SkillInfo) => void;
  isInstallingSkill: (skill: SkillInfo) => boolean;
  isRemovingSkill: (skill: SkillInfo) => boolean;
  /** Skill awaiting removal confirmation (drives `SkillRemovalDialog`). */
  skillPendingRemoval: SkillInfo | null;
  confirmRemove: () => void;
  cancelRemove: () => void;
}

/**
 * Install / remove actions for skills, shared by the Skills list and the
 * skill detail page. Owns the per-skill pending state, the confirm-gated
 * removal flow, and skills-cache invalidation after either mutation settles.
 */
export function useSkillActions(
  assistantId: string,
  { onRemoved }: UseSkillActionsOptions = {},
): UseSkillActionsResult {
  const queryClient = useQueryClient();

  const [installingSkillId, setInstallingSkillId] = useState<string | null>(
    null,
  );
  const [removingSkillId, setRemovingSkillId] = useState<string | null>(null);
  const [skillPendingRemoval, setSkillPendingRemoval] =
    useState<SkillInfo | null>(null);

  const invalidateSkills = useCallback(() => {
    invalidateSkillsList(queryClient, assistantId);
  }, [assistantId, queryClient]);

  const installMutation = useMutation({
    mutationFn: (slug: string) => installSkill(assistantId, slug),
    onMutate: (slug) => setInstallingSkillId(slug),
    onSettled: () => {
      setInstallingSkillId(null);
      invalidateSkills();
    },
  });

  const uninstallMutation = useSkillsByIdDeleteMutation({
    onMutate: (variables) => setRemovingSkillId(variables.path.id),
    onSuccess: () => {
      onRemoved?.();
    },
    onSettled: () => {
      setRemovingSkillId(null);
      invalidateSkills();
    },
  });

  const handleInstall = useCallback(
    (skill: SkillInfo) => {
      installMutation.mutate(skill.slug ?? skill.id);
    },
    [installMutation],
  );

  const handleRemove = useCallback((skill: SkillInfo) => {
    setSkillPendingRemoval(skill);
  }, []);

  const confirmRemove = useCallback(() => {
    if (!skillPendingRemoval) {
      return;
    }
    uninstallMutation.mutate({
      path: { assistant_id: assistantId, id: skillPendingRemoval.id },
    });
    setSkillPendingRemoval(null);
  }, [assistantId, skillPendingRemoval, uninstallMutation]);

  const cancelRemove = useCallback(() => {
    setSkillPendingRemoval(null);
  }, []);

  const isInstallingSkill = useCallback(
    (skill: SkillInfo) => installingSkillId === (skill.slug ?? skill.id),
    [installingSkillId],
  );

  const isRemovingSkill = useCallback(
    (skill: SkillInfo) => removingSkillId === skill.id,
    [removingSkillId],
  );

  return {
    handleInstall,
    handleRemove,
    isInstallingSkill,
    isRemovingSkill,
    skillPendingRemoval,
    confirmRemove,
    cancelRemove,
  };
}

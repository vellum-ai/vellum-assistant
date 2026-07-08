/**
 * Right-hand side-drawer showing a skill's detail next to the chat: skill
 * emoji + name header, description + SKILL.md body rendered as markdown, and
 * a pinned "Go to Skill" footer that navigates to the skill's dedicated page.
 * Removal (installed skills only) lives behind a header overflow menu with a
 * confirmation dialog; on success the panel closes.
 *
 * SKILL.md resolution (files list → SKILL.md entry → content) comes from the
 * shared `useSkillDetailFiles` hook — the same chain the intelligence
 * skill-detail views use, so the caches are shared.
 *
 * Driven by `activeSkillDetailId` in `viewer-store` (see `openSkillDetail`).
 * Rendered inside the shared chat `AnimatedRightDrawer` by
 * `chat-content-layout`, matching its sibling `ToolDetailPanel`.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { Button, Menu, Typography } from "@vellumai/design-library";

import { FileMarkdown } from "@/components/file-markdown";
import { SkillLineageLink } from "@/components/skill-lineage-link";
import { SkillRemovalDialog } from "@/components/skill-removal-dialog";
import { DetailShell } from "@/domains/chat/components/detail-shell";
import {
  skillsByIdGetOptions,
  useSkillsByIdDeleteMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useSkillDetailFiles } from "@/hooks/use-skill-detail-files";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";
import { invalidateSkillsList, isRemovableSkill } from "@/utils/skills";

interface SkillDetailPanelProps {
  skillId: string;
  onClose: () => void;
}

export function SkillDetailPanel({ skillId, onClose }: SkillDetailPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  const skillQuery = useQuery({
    ...skillsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: skillId },
    }),
    select: (data) => data.skill,
    enabled: Boolean(assistantId),
  });
  const skill = skillQuery.data;

  const {
    skillMd,
    fileContent: skillMdContent,
    isFilesPending,
    isContentPending,
  } = useSkillDetailFiles(assistantId, skillId);

  const removeMutation = useSkillsByIdDeleteMutation({
    onSuccess: () => {
      if (assistantId) {
        invalidateSkillsList(queryClient, assistantId);
      }
      onClose();
    },
    onError: (error) => {
      captureError(error, { context: "skill-detail-panel-remove" });
    },
  });

  const confirmRemove = () => {
    if (!assistantId) {
      return;
    }
    removeMutation.mutate({ path: { assistant_id: assistantId, id: skillId } });
    setConfirmingRemoval(false);
  };

  // `isPending` (no data yet) rather than `isLoading` (actively fetching) so
  // the disabled-query window while `assistantId` resolves also shows the
  // spinner instead of a flash of empty body. The content query only counts
  // once a SKILL.md entry exists — a skill without one isn't "loading".
  const isLoading =
    skillQuery.isPending ||
    isFilesPending ||
    (skillMd != null && isContentPending);

  const removable = skill != null && isRemovableSkill(skill);

  return (
    <>
      <DetailShell
        // `icon` wins over `Glyph` in DetailShell, so Brain is the
        // no-emoji fallback (matching the skill-created-card rows).
        icon={
          skill?.emoji ? (
            <span className="text-xl leading-none" aria-hidden>
              {skill.emoji}
            </span>
          ) : undefined
        }
        Glyph={Brain}
        title={skill?.name ?? "Skill"}
        closeLabel="Close skill details"
        onClose={onClose}
        headerActions={
          removable ? (
            <Menu.Root>
              <Menu.Trigger asChild>
                <Button
                  variant="ghost"
                  iconOnly={<MoreHorizontal />}
                  aria-label="Skill actions"
                  className="shrink-0"
                />
              </Menu.Trigger>
              <Menu.Content side="bottom" align="end">
                <Menu.Item
                  leftIcon={<Trash2 size={14} />}
                  onSelect={() => setConfirmingRemoval(true)}
                >
                  Remove skill
                </Menu.Item>
              </Menu.Content>
            </Menu.Root>
          ) : undefined
        }
        footer={
          <Button
            fullWidth
            onClick={() => navigate(routes.skills.detail(skillId))}
          >
            Go to Skill
          </Button>
        }
      >
        {skillQuery.isError ? (
          <Typography
            variant="body-medium-lighter"
            as="p"
            className="py-8 text-center text-[var(--content-tertiary)]"
          >
            This skill could not be loaded. It may have been removed.
          </Typography>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--content-tertiary)]" />
          </div>
        ) : (
          <>
            {skill?.description && (
              <Typography
                variant="body-medium-lighter"
                as="p"
                className="mb-4 text-[var(--content-secondary)]"
              >
                {skill.description}
              </Typography>
            )}
            {skill && (
              <SkillLineageLink
                skill={skill}
                className="mb-4"
                onNavigate={onClose}
              />
            )}
            {skillMdContent && <FileMarkdown content={skillMdContent} />}
          </>
        )}
      </DetailShell>

      <SkillRemovalDialog
        skillName={confirmingRemoval && skill ? skill.name : null}
        onConfirm={confirmRemove}
        onCancel={() => setConfirmingRemoval(false)}
      />
    </>
  );
}

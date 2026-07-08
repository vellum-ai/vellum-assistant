/**
 * Right-hand side-drawer showing a skill's detail next to the chat: skill
 * emoji + name header, description + SKILL.md body rendered as markdown, and
 * a pinned "Go to Skill" footer that navigates to the skill's dedicated page.
 * Removal (installed skills only) lives behind a header overflow menu with a
 * confirmation dialog; on success the panel closes.
 *
 * Driven by `activeSkillDetailId` in `viewer-store` (see `openSkillDetail`).
 * Rendered inside the shared chat `AnimatedRightDrawer` by
 * `chat-content-layout`, matching its sibling `ToolDetailPanel`.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import {
  Button,
  ConfirmDialog,
  Menu,
  Typography,
} from "@vellumai/design-library";

import { FileMarkdown } from "@/components/file-markdown";
import { DetailShell } from "@/domains/chat/components/detail-shell";
import {
  skillsByIdFilesContentGetOptions,
  skillsByIdFilesGetOptions,
  skillsByIdGetOptions,
  useSkillsByIdDeleteMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

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

  // SKILL.md is resolved the way the intelligence skill-detail views do:
  // list the skill's files, find the SKILL.md entry by name, fetch its
  // content. (Duplicated from `domains/intelligence` rather than imported —
  // cross-domain imports are disallowed.)
  const filesQuery = useQuery({
    ...skillsByIdFilesGetOptions({
      path: { assistant_id: assistantId ?? "", id: skillId },
    }),
    enabled: Boolean(assistantId),
  });
  const skillMdPath =
    filesQuery.data?.files.find((f) => f.name === "SKILL.md")?.path ?? null;
  const contentQuery = useQuery({
    ...skillsByIdFilesContentGetOptions({
      path: { assistant_id: assistantId ?? "", id: skillId },
      query: { path: skillMdPath ?? "" },
    }),
    enabled: Boolean(assistantId && skillMdPath),
  });

  const removeMutation = useSkillsByIdDeleteMutation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [{ _id: "skillsGet" }] });
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
  // once a SKILL.md path exists — a skill without one isn't "loading".
  const isLoading =
    skillQuery.isPending ||
    filesQuery.isPending ||
    (skillMdPath != null && contentQuery.isPending);
  const skillMdContent = contentQuery.data?.content ?? null;

  // Bundled skills ship with the assistant and can't be removed; the daemon
  // rejects deletes for anything but installed skills.
  const removable = skill?.kind === "installed";

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
            {skillMdContent && <FileMarkdown content={skillMdContent} />}
          </>
        )}
      </DetailShell>

      <ConfirmDialog
        open={confirmingRemoval}
        title="Remove skill"
        message={skill ? `Remove "${skill.name}" from this assistant?` : ""}
        confirmLabel="Remove"
        destructive
        onConfirm={confirmRemove}
        onCancel={() => setConfirmingRemoval(false)}
      />
    </>
  );
}

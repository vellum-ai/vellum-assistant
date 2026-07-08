import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    ArrowDownToLine,
    ArrowLeft,
    ExternalLink,
    FileText,
    Folder,
    Loader2,
    Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import {
    ContentActionBar,
    EditFooter,
    FileTextarea,
    SourcePre,
} from "@/components/file-editor";
import { FileMarkdown, isMarkdown } from "@/components/file-markdown";
import { SkillLineageLink } from "@/components/skill-lineage-link";
import { SkillIcon } from "@/domains/intelligence/components/skills/skill-icon";
import { SkillOriginBadge } from "@/domains/intelligence/components/skills/skill-origin-badge";
import {
    isAvailableSkill,
    isRemovableSkill,
    type SkillFileEntry,
    type SkillInfo,
} from "@/domains/intelligence/skills/types";
import {
    skillsByIdFilesContentGetOptions,
    skillsByIdFilesGetOptions,
    useWorkspaceWritePostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { SkillsByIdFilesContentGetResponse } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { routes } from "@/utils/routes";
import { Button, Card } from "@vellumai/design-library";

interface SkillDetailProps {
  assistantId: string;
  skill: SkillInfo;
  onBack: () => void;
  onInstall?: () => void;
  onRemove?: () => void;
  isInstalling?: boolean;
  isRemoving?: boolean;
  /**
   * Source conversation this skill was distilled from (assistant-memory
   * skills only) — renders a quiet lineage link when present.
   */
  sourceConversationId?: string;
}

export function SkillDetail({
  assistantId,
  skill,
  onBack,
  onInstall,
  onRemove,
  isInstalling = false,
  isRemoving = false,
  sourceConversationId,
}: SkillDetailProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const available = isAvailableSkill(skill);
  const removable = isRemovableSkill(skill);

  const filesQuery = useQuery({
    ...skillsByIdFilesGetOptions({
      path: { assistant_id: assistantId, id: skill.id },
    }),
    select: (data) => data ?? null,
  });

  const fileEntries = useMemo<SkillFileEntry[]>(
    () => filesQuery.data?.files ?? [],
    [filesQuery.data],
  );

  const skillMd = useMemo(
    () => fileEntries.find((f) => f.name === "SKILL.md"),
    [fileEntries],
  );

  const activePath = selectedPath ?? skillMd?.path ?? null;

  const fileContentQuery = useQuery({
    ...skillsByIdFilesContentGetOptions({
      path: { assistant_id: assistantId, id: skill.id },
      query: { path: activePath ?? "" },
    }),
    select: (data): SkillsByIdFilesContentGetResponse | null => data ?? null,
    enabled: Boolean(activePath),
  });

  const activeFile = fileEntries.find((f) => f.path === activePath);

  return (
    <div className="flex h-[calc(100vh-14rem)] flex-col">
      <div className="mb-4 flex items-start gap-3">
        <Button
          type="button"
          variant="ghost"
          iconOnly={<ArrowLeft aria-hidden />}
          aria-label="Back to skills"
          onClick={onBack}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <SkillIcon skill={skill} className="h-8 w-8 text-3xl" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2
                  className="text-title-medium"
                  style={{ color: "var(--content-default)" }}
                >
                  {skill.name}
                </h2>
                <SkillOriginBadge origin={skill.origin} />
              </div>
              <p
                className="mt-0.5 line-clamp-2 text-body-medium-lighter"
                style={{ color: "var(--content-secondary)" }}
              >
                {skill.description}
              </p>
              <SkillLineageLink
                skill={{ origin: skill.origin, sourceConversationId }}
                className="mt-1"
              />
            </div>
          </div>
          {available ? (
            isInstalling ? (
              <div className="flex h-9 items-center px-3">
                <Loader2
                  className="h-4 w-4 animate-spin"
                  style={{ color: "var(--content-tertiary)" }}
                />
              </div>
            ) : (
              <Button
                type="button"
                onClick={onInstall}
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
              onClick={onRemove}
              disabled={!removable || isRemoving || !onRemove}
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
      </div>

      <Card.Root asChild noPadding>
        <div
          className="flex flex-1 flex-col overflow-hidden sm:grid"
          style={{
            gridTemplateColumns: "240px 1fr",
          }}
        >
        <div
          className="max-h-40 shrink-0 overflow-y-auto border-b p-2 sm:max-h-none sm:border-b-0 sm:border-r"
          style={{ borderColor: "var(--border-base)" }}
        >
          {filesQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2
                className="h-4 w-4 animate-spin"
                style={{ color: "var(--content-tertiary)" }}
              />
            </div>
          ) : fileEntries.length === 0 ? (
            <p
              className="px-3 py-4 text-center text-body-medium-lighter"
              style={{ color: "var(--content-tertiary)" }}
            >
              No files available.
            </p>
          ) : (
            fileEntries.map((entry) => {
              const isActive = activePath === entry.path;
              const isDirectory = (entry.mimeType ?? "").endsWith("/directory");
              return (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => setSelectedPath(entry.path)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-body-medium-lighter transition-colors hover:bg-[var(--surface-hover)]"
                  style={{
                    color: isActive
                      ? "var(--primary-base)"
                      : "var(--content-default)",
                    backgroundColor: isActive
                      ? "color-mix(in oklab, var(--primary-base) 10%, transparent)"
                      : undefined,
                  }}
                >
                  {isDirectory ? (
                    <Folder
                      className="h-4 w-4 shrink-0"
                      style={{ color: "var(--system-mid-strong)" }}
                    />
                  ) : (
                    <FileText
                      className="h-4 w-4 shrink-0"
                      style={{ color: "var(--content-secondary)" }}
                    />
                  )}
                  <span className="truncate">{entry.name}</span>
                </button>
              );
            })
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {fileContentQuery.isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2
                className="h-6 w-6 animate-spin"
                style={{ color: "var(--content-tertiary)" }}
              />
            </div>
          ) : activeFile ? (
            <SkillFileContent
              key={`${skill.id}/${activeFile.path}`}
              assistantId={assistantId}
              skillId={skill.id}
              fileName={activeFile.name}
              filePath={activeFile.path}
              content={fileContentQuery.data?.content ?? null}
              isBinary={Boolean(fileContentQuery.data?.isBinary)}
              editable={skill.kind === "installed"}
            />
          ) : (
            <p
              className="flex h-full items-center justify-center text-body-medium-lighter"
              style={{ color: "var(--content-tertiary)" }}
            >
              Select a file to view its contents.
            </p>
          )}
        </div>
        </div>
      </Card.Root>
    </div>
  );
}

function SkillFileContent({
  assistantId,
  skillId,
  fileName,
  filePath,
  content,
  isBinary,
  editable,
}: {
  assistantId: string;
  skillId: string;
  fileName: string;
  filePath: string;
  content: string | null;
  isBinary: boolean;
  editable: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [editableContent, setEditableContent] = useState("");

  const workspacePath = `skills/${skillId}/${filePath}`;

  const saveMutation = useWorkspaceWritePostMutation({
    onSuccess: () => {
      setIsEditing(false);
      setEditableContent("");
      void queryClient.invalidateQueries({
        queryKey: [{ _id: "skillsByIdFilesContentGet" }],
      });
      void queryClient.invalidateQueries({
        queryKey: [{ _id: "skillsByIdFilesGet" }],
      });
      if (filePath === "SKILL.md") {
        void queryClient.invalidateQueries({
          queryKey: [{ _id: "skillsGet" }],
        });
      }
    },
    onError: (error) => {
      captureError(error, { context: "skill-file-save", bestEffort: true });
    },
  });

  const isDirty = isEditing && editableContent !== (content ?? "");

  const handleSave = useCallback(() => {
    if (!isDirty || saveMutation.isPending) return;
    saveMutation.mutate({
      path: { assistant_id: assistantId },
      body: { path: workspacePath, content: editableContent, encoding: "utf8" },
    });
  }, [isDirty, saveMutation, assistantId, workspacePath, editableContent]);

  const startEditing = useCallback(() => {
    setIsEditing(true);
    setEditableContent(content ?? "");
    saveMutation.reset();
  }, [content, saveMutation]);

  const stopEditing = useCallback(() => {
    setIsEditing(false);
    setEditableContent("");
    saveMutation.reset();
  }, [saveMutation]);

  if (isBinary) {
    return (
      <p
        className="flex h-full items-center justify-center text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        Binary file — no preview available.
      </p>
    );
  }

  if (content === null) {
    return (
      <p
        className="flex h-full items-center justify-center text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        No preview available for {fileName}.
      </p>
    );
  }

  const openInWorkspaceButton = editable ? (
    <Button
      variant="ghost"
      size="regular"
      iconOnly={<ExternalLink aria-hidden />}
      onClick={() =>
        navigate(
          `${routes.workspace}?file=${encodeURIComponent(workspacePath)}`,
        )
      }
      aria-label="Open in Workspace"
      className="hover:bg-[var(--surface-base)]"
    />
  ) : undefined;

  if (isMarkdown(fileName, undefined) && !isEditing) {
    return (
      <div className="relative flex h-full flex-col">
        <div
          className="relative flex-1 overflow-auto px-6 py-4"
          style={{ color: "var(--content-default)" }}
        >
          <ContentActionBar
            content={content}
            fileName={fileName}
            showEdit={editable}
            isEditing={false}
            onToggleEdit={startEditing}
            extraActions={openInWorkspaceButton}
          />
          <FileMarkdown content={content} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1 overflow-hidden">
        <ContentActionBar
          content={isEditing ? editableContent : content}
          fileName={fileName}
          showEdit={editable}
          isEditing={isEditing}
          onToggleEdit={() => (isEditing ? stopEditing() : startEditing())}
          extraActions={openInWorkspaceButton}
        />
        {isEditing ? (
          <FileTextarea
            value={editableContent}
            onChange={setEditableContent}
            onSave={handleSave}
          />
        ) : (
          <SourcePre
            content={content}
            readOnly={!editable}
            onStartEdit={startEditing}
          />
        )}
      </div>
      {isEditing && (
        <EditFooter
          isDirty={isDirty}
          isSaving={saveMutation.isPending}
          error={saveMutation.isError ? "Save failed" : null}
          onSave={handleSave}
          onDiscard={stopEditing}
        />
      )}
    </div>
  );
}

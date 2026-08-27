import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowLeft,
  ExternalLink,
  FileText,
  Folder,
  Loader2,
  Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";

import {
  ContentActionBar,
  EditFooter,
  FileTextarea,
  SourcePre,
} from "@/components/file-editor";
import { FileMarkdown, isMarkdown } from "@/components/file-markdown";
import { SkillLineageLink } from "@/components/skill-lineage-link";
import { SkillIcon } from "@/components/skill-icon";
import { SkillOriginBadge } from "@/domains/intelligence/components/skills/skill-origin-badge";
import { SkillRevisionHistory } from "@/domains/intelligence/components/skills/skill-revision-history";
import {
  isAvailableSkill,
  type SkillInfo,
} from "@/domains/intelligence/skills/types";
import { useWorkspaceWritePostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useSkillDetailFiles } from "@/hooks/use-skill-detail-files";
import {
  shouldShowHistoryTab,
  useSkillHistory,
} from "@/hooks/use-skill-history";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { openWorkspaceFile } from "@/utils/open-workspace-file";
import { invalidateSkillsList, isRemovableSkill } from "@/utils/skills";
import { Button, Card, Tabs } from "@vellumai/design-library";

export type SkillDetailTab = "files" | "history";

/**
 * Narrow an arbitrary tab value (a `?tab=` param, a Radix `onValueChange`
 * string) to a tab the page renders; anything else is Files.
 */
export function parseSkillDetailTab(value: string | null): SkillDetailTab {
  return value === "history" ? "history" : "files";
}

interface SkillDetailProps {
  assistantId: string;
  skill: SkillInfo;
  /**
   * Which tab is selected. The route page owns it (it rides `?tab=` so a
   * link can open the page straight onto History, as the in-chat Level Up
   * card does); this component only pins it to Files while History is
   * hidden.
   */
  tab: SkillDetailTab;
  onTabChange: (tab: SkillDetailTab) => void;
  onBack: () => void;
  /**
   * True when `onBack` returns to the conversation the skill was opened
   * from (chat-origin `backTo` router state) rather than the skills list,
   * so the back control announces where it actually lands.
   */
  backToConversation?: boolean;
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
  tab,
  onTabChange,
  onBack,
  backToConversation = false,
  onInstall,
  onRemove,
  isInstalling = false,
  isRemoving = false,
  sourceConversationId,
}: SkillDetailProps) {
  const { t } = useTranslation("intelligence");
  const available = isAvailableSkill(skill);
  const removable = isRemovableSkill(skill);

  const {
    fileEntries,
    setSelectedPath,
    activePath,
    activeFile,
    isFilesLoading,
    fileContent,
    isBinary,
    isContentLoading,
  } = useSkillDetailFiles(assistantId, skill.id);

  // Shares a query key with the panel below, so this is one request, not two.
  const {
    revisions,
    isLoading: isHistoryLoading,
    isError: isHistoryError,
  } = useSkillHistory(assistantId, skill.id);

  const showHistory = shouldShowHistoryTab({
    isLoading: isHistoryLoading,
    isError: isHistoryError,
    revisionCount: revisions.length,
  });

  // Pin to Files whenever the strip is hidden, so the page never rests on an
  // unrendered panel. A History deep link therefore shows Files while the
  // history query is in flight and switches once revisions arrive.
  const activeTab: SkillDetailTab = showHistory ? tab : "files";

  const header = (
    <div className="mb-4 flex items-start gap-3">
      <Button
        type="button"
        variant="ghost"
        iconOnly={<ArrowLeft aria-hidden />}
        aria-label={t(
          backToConversation
            ? "skillDetail.backToConversationAriaLabel"
            : "skillDetail.backToSkillsAriaLabel",
        )}
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
              {t("skillDetail.install")}
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
            {t("skillDetail.remove")}
          </Button>
        )}
      </div>
    </div>
  );

  const filesCard = (
    <Card.Root asChild noPadding>
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden sm:grid"
        style={{
          gridTemplateColumns: "240px 1fr",
        }}
      >
        <div
          className="max-h-40 shrink-0 overflow-y-auto border-b p-2 sm:max-h-none sm:border-b-0 sm:border-r"
          style={{ borderColor: "var(--border-base)" }}
        >
          {isFilesLoading ? (
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
              {t("skillDetail.noFilesAvailable")}
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
          {isContentLoading ? (
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
              content={fileContent}
              isBinary={isBinary}
              editable={skill.kind === "installed"}
            />
          ) : (
            <p
              className="flex h-full items-center justify-center text-body-medium-lighter"
              style={{ color: "var(--content-tertiary)" }}
            >
              {t("skillDetail.selectFilePrompt")}
            </p>
          )}
        </div>
      </div>
    </Card.Root>
  );

  return (
    <div className="flex h-[calc(100vh-14rem)] flex-col">
      {header}
      {/*
        `SkillFileContent` holds the in-progress edit in local state, and Radix
        unmounts an inactive panel, so the files panel is force-mounted and
        only the tab strip and history panel are conditional. Visibility rides
        an inline `display` to avoid a precedence fight between `hidden` and
        `flex`.
      */}
      <Tabs.Root
        value={activeTab}
        onValueChange={(value) => onTabChange(parseSkillDetailTab(value))}
        className="flex min-h-0 flex-1 flex-col"
      >
        {showHistory && (
          <Tabs.List className="mb-3">
            <Tabs.Trigger value="files">
              {t("skillDetail.filesTab")}
            </Tabs.Trigger>
            <Tabs.Trigger value="history">
              {t("skillDetail.historyTab")}
            </Tabs.Trigger>
          </Tabs.List>
        )}
        <Tabs.Panel
          value="files"
          forceMount
          className="min-h-0 flex-1 flex-col"
          style={{ display: activeTab === "files" ? "flex" : "none" }}
        >
          {filesCard}
        </Tabs.Panel>
        {showHistory && (
          <Tabs.Panel value="history" className="flex min-h-0 flex-1 flex-col">
            <Card.Root asChild noPadding>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SkillRevisionHistory
                  assistantId={assistantId}
                  skillId={skill.id}
                />
              </div>
            </Card.Root>
          </Tabs.Panel>
        )}
      </Tabs.Root>
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
  const { t } = useTranslation("intelligence");
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
      // History has no push channel and its query disables focus refetches, so
      // without this a History tab opened after a save keeps showing the
      // pre-save list for the rest of the session. The new revision appears
      // once the workspace heartbeat commits, not at save time, so this
      // refetch is what eventually surfaces it rather than an immediate
      // guarantee.
      void queryClient.invalidateQueries({
        queryKey: [{ _id: "skillsByIdHistoryGet" }],
      });
      if (filePath === "SKILL.md") {
        invalidateSkillsList(queryClient, assistantId);
      }
    },
    onError: (error) => {
      captureError(error, { context: "skill-file-save", bestEffort: true });
    },
  });

  const isDirty = isEditing && editableContent !== (content ?? "");

  const handleSave = useCallback(() => {
    if (!isDirty || saveMutation.isPending) {
      return;
    }
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
        {t("skillFileContent.binaryFile")}
      </p>
    );
  }

  if (content === null) {
    return (
      <p
        className="flex h-full items-center justify-center text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        {t("skillFileContent.noPreviewAvailable", { fileName })}
      </p>
    );
  }

  const openInWorkspaceButton = editable ? (
    <Button
      variant="ghost"
      size="regular"
      iconOnly={<ExternalLink aria-hidden />}
      onClick={() => void openWorkspaceFile(workspacePath)}
      aria-label={t("skillDetail.openInWorkspaceAriaLabel")}
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
          error={saveMutation.isError ? t("skillDetail.saveFailed") : null}
          onSave={handleSave}
          onDiscard={stopEditing}
        />
      )}
    </div>
  );
}

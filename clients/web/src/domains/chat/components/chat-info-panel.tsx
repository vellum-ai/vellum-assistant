/**
 * The Chat Info panel: a conversation's apps, its documents and images, and
 * its camera frames, each as one fitted row of tiles.
 *
 * A category holding more than the row shows offers See All, which drills into
 * a second level inside this same panel: the back control takes the header's
 * leading slot, the title becomes "Category · N", and the body becomes a
 * wrapping grid of the whole category. The drilled-in category lives in the
 * payload, so a remount of the mobile overlay cannot lose it.
 */

import { ChevronLeft, Layers } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo } from "react";

import { Button } from "@vellumai/design-library";

import { DeleteAppDialog } from "@/components/delete-app-dialog";
import {
  DetailShell,
  type DetailShellHeaderProps,
  DetailShellNotice,
  DetailShellTitleWithCount,
} from "@/components/detail-shell";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import {
  CHAT_INFO_APP_TILE_WIDTH_PX,
  ChatInfoAppTile,
} from "@/domains/chat/components/chat-info-app-tile";
import { ChatInfoFileGrid } from "@/domains/chat/components/chat-info-file-grid";
import {
  type ChatInfoFileCategory,
  ChatInfoFileRow,
} from "@/domains/chat/components/chat-info-file-row";
import { ChatInfoSection } from "@/domains/chat/components/chat-info-section";
import {
  type ConversationFileAsset,
  useConversationAssets,
} from "@/domains/chat/hooks/use-conversation-assets";
import {
  openAppFromChat,
  openDocumentFromChat,
} from "@/domains/chat/hooks/use-open-app-from-chat";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";
import { useAppDelete } from "@/hooks/use-app-delete";
import { useTranslation } from "@/i18n";
import {
  type ChatInfoCategory,
  type ChatInfoPayload,
  useViewerStore,
} from "@/stores/viewer-store";
import type { DisplayAttachment } from "@/types/attachment-types";

interface ChatInfoPanelProps {
  payload: ChatInfoPayload;
  onClose: () => void;
  /** See All drills in with a category; the back control passes `null`. */
  onSelectCategory: (category: ChatInfoCategory | null) => void;
}

export function ChatInfoPanel({
  payload,
  onClose,
  onSelectCategory,
}: ChatInfoPanelProps) {
  const { t } = useTranslation("chat");
  const { assistantId, conversationId } = payload;

  // No `refreshKey`: the header trigger owns invalidation.
  const {
    apps,
    files,
    frames,
    counts,
    count,
    status,
    hasMoreFiles,
    hasMoreFrames,
    loadMoreFiles,
    loadMoreFrames,
  } = useConversationAssets({ assistantId, conversationId });

  // The gallery spans both file categories, so arrowing out of the frames
  // grid walks into the conversation's own photos rather than stopping. Each
  // tile carries its own position because two legacy rows can hold the same
  // `rehydrated:N` attachment id, which the modal's id lookup cannot separate.
  const { previewable, previewIndexById } = useMemo(() => {
    const attachments: DisplayAttachment[] = [];
    const indexById = new Map<string, number>();
    for (const file of [...files, ...frames]) {
      if (file.kind === "document") {
        continue;
      }
      indexById.set(file.id, attachments.length);
      attachments.push(file.attachment);
    }
    return { previewable: attachments, previewIndexById: indexById };
  }, [files, frames]);
  const { openPreview, previewModal } = useAttachmentPreview(
    assistantId,
    previewable,
  );

  const appDelete = useAppDelete(assistantId);

  // The panel showing a conversation's assets is the user looking at them, so
  // a change that lands while it is open is seen the moment it arrives. It
  // clears here rather than at the header trigger because every entry point
  // into the panel passes through this component.
  const unseenDocuments =
    useUnseenDocumentChangesStore.use.changedDocuments()[conversationId];
  const clearConversation =
    useUnseenDocumentChangesStore.use.clearConversation();
  useEffect(() => {
    if (unseenDocuments !== undefined) {
      clearConversation(conversationId);
    }
  }, [clearConversation, conversationId, unseenDocuments]);

  // Closing first returns the viewer to whatever the panel was opened from,
  // so the asset lands there rather than behind the panel. The app opens
  // under the panel's own assistant, which need not be the active one.
  const handleOpenApp = useCallback(
    (appId: string) => {
      useViewerStore.getState().closeChatInfo();
      void openAppFromChat(assistantId, appId);
    },
    [assistantId],
  );

  const handleOpenFile = useCallback(
    (file: ConversationFileAsset) => {
      if (file.kind === "document") {
        useViewerStore.getState().closeChatInfo();
        void openDocumentFromChat(assistantId, file.doc.surfaceId);
        return;
      }
      // The modal sits above the panel, so the panel stays open behind it.
      openPreview(file.attachment, previewIndexById.get(file.id));
    },
    [assistantId, openPreview, previewIndexById],
  );

  const categoryTitles: Record<ChatInfoCategory, string> = {
    apps: t("chatInfoPanel.appsTitle"),
    files: t("chatInfoPanel.filesTitle"),
    frames: t("chatInfoPanel.framesTitle"),
  };
  const categoryLists = { apps, files, frames };

  // A category emptied while drilled in (the last app deleted) falls back to
  // the top level rather than rendering an empty page. Only once the sources
  // are ready: a category not loaded yet is empty for a different reason.
  const emptiedCategory =
    status === "ready" &&
    payload.category !== null &&
    categoryLists[payload.category].length === 0;
  const level = emptiedCategory ? null : payload.category;

  // The fallback above is what this frame renders; the store still holds the
  // category, so it is settled too. Otherwise a refilled category would drill
  // back in on its own, and See All on that same category would no-op.
  useEffect(() => {
    if (emptiedCategory) {
      onSelectCategory(null);
    }
  }, [emptiedCategory, onSelectCategory]);

  const renderFileRow = (category: ChatInfoFileCategory) => {
    const items = categoryLists[category];
    if (items.length === 0) {
      return null;
    }
    return (
      <ChatInfoFileRow
        category={category}
        title={categoryTitles[category]}
        count={counts[category]}
        items={items}
        seeAllAriaLabel={
          category === "files"
            ? t("chatInfoPanel.seeAllFilesAria")
            : t("chatInfoPanel.seeAllFramesAria")
        }
        onSeeAll={onSelectCategory}
        onOpen={handleOpenFile}
        assistantId={assistantId}
      />
    );
  };

  let body: ReactNode;
  if (level === "apps") {
    body = (
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${CHAT_INFO_APP_TILE_WIDTH_PX}px, 1fr))`,
        }}
      >
        {apps.map((app) => (
          <ChatInfoAppTile
            key={app.id}
            app={app}
            assistantId={assistantId}
            stretch
            onOpen={handleOpenApp}
            onRequestDelete={appDelete.requestDelete}
          />
        ))}
      </div>
    );
  } else if (level !== null) {
    body = (
      <ChatInfoFileGrid
        items={categoryLists[level]}
        assistantId={assistantId}
        hasMore={level === "files" ? hasMoreFiles : hasMoreFrames}
        onLoadMore={level === "files" ? loadMoreFiles : loadMoreFrames}
        onOpen={handleOpenFile}
      />
    );
  } else {
    // Every category holding anything is listed whatever the sources are
    // doing, since the transcript attachments are on screen from the first
    // paint. A source still loading says nothing at all: a flash of copy reads
    // as an answer the loaded panel then replaces.
    body = (
      <div className="flex flex-col gap-8">
        {status === "ready" && count === 0 && (
          <DetailShellNotice>{t("chatInfoPanel.empty")}</DetailShellNotice>
        )}
        {apps.length > 0 && (
          <ChatInfoSection
            title={categoryTitles.apps}
            count={counts.apps}
            items={apps}
            tileWidth={CHAT_INFO_APP_TILE_WIDTH_PX}
            seeAllAriaLabel={t("chatInfoPanel.seeAllAppsAria")}
            onSeeAll={() => onSelectCategory("apps")}
            renderTile={(app, layout) => (
              <ChatInfoAppTile
                key={app.id}
                app={app}
                assistantId={assistantId}
                stretch={layout === "fitted"}
                onOpen={handleOpenApp}
                onRequestDelete={appDelete.requestDelete}
              />
            )}
          />
        )}
        {renderFileRow("files")}
        {renderFileRow("frames")}
      </div>
    );
  }

  const headerProps: Pick<
    DetailShellHeaderProps,
    "Glyph" | "icon" | "title" | "titleNode"
  > =
    level === null
      ? { Glyph: Layers, title: t("chatInfoPanel.title") }
      : {
          // The back control takes the leading slot the glyph would occupy,
          // matching the activity-steps, subagent, and ACP run panels.
          icon: (
            <Button
              variant="outlined"
              iconOnly={<ChevronLeft />}
              aria-label={t("chatInfoPanel.backAria")}
              tooltip={t("chatInfoPanel.backTooltip")}
              onClick={() => onSelectCategory(null)}
              className="shrink-0"
            />
          ),
          titleNode: (
            <DetailShellTitleWithCount
              title={categoryTitles[level]}
              count={counts[level]}
            />
          ),
        };

  return (
    <DetailShell
      {...headerProps}
      closeLabel={t("chatInfoPanel.closeAria")}
      closeTooltip={t("chatInfoPanel.closeAria")}
      onClose={onClose}
    >
      {/* Above the body at every level: a category drilled into with nothing
          cached would otherwise be a blank grid with no reason given. */}
      {status === "error" && (
        <DetailShellNotice>{t("chatInfoPanel.loadFailed")}</DetailShellNotice>
      )}
      {body}
      {/* Both overlays live in the body so a level switch cannot unmount them. */}
      {previewModal}
      <DeleteAppDialog
        app={appDelete.pendingDelete}
        isDeleting={appDelete.isDeleting}
        onConfirm={appDelete.confirmDelete}
        onCancel={appDelete.cancelDelete}
      />
    </DetailShell>
  );
}

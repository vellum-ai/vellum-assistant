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
import { Fragment, type ReactNode } from "react";
import { useCallback, useEffect, useMemo } from "react";

import { Button, Notice } from "@vellumai/design-library";

import { DeleteAppDialog } from "@/components/delete-app-dialog";
import {
  DetailShell,
  type DetailShellHeaderProps,
  DetailShellLoading,
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
  useOpenAppFromChat,
  useOpenDocumentFromChat,
} from "@/domains/chat/hooks/use-open-app-from-chat";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";
import { useAppDelete } from "@/hooks/use-app-delete";
import {
  summarizeAssetSources,
  type ConversationAssetSource,
} from "@/lib/conversation-asset-sources";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
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
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const openDocument = useOpenDocumentFromChat(
    assistantId,
    useViewerStore.getState().closeChatInfo,
  );
  const openApp = useOpenAppFromChat();

  // No `refreshKey`: the header trigger owns invalidation.
  const {
    apps,
    files,
    frames,
    counts,
    count,
    status,
    allFailed,
    countsExact,
    sources,
    retrySource,
    retryFailedSources,
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

  // The panel is about one assistant's conversation and its tiles reach that
  // assistant's apps, so it does not outlive a switch away from it. A cleared
  // id is a teardown or a gap between two connects, not a switch.
  useEffect(() => {
    if (activeAssistantId !== null && activeAssistantId !== assistantId) {
      useViewerStore.getState().closeChatInfo();
    }
  }, [activeAssistantId, assistantId]);

  // An app is a route under the active assistant, so a tile opens only while
  // this panel's assistant is that one; the dismissal above runs in an effect,
  // so a click in the same commit still has to refuse. Closing first returns
  // the viewer to whatever the panel was opened from, so the app lands there
  // rather than behind the panel. The app hangs off the conversation this
  // panel is about, not whatever the route names.
  const handleOpenApp = useCallback(
    (appId: string) => {
      if (assistantId !== activeAssistantId) {
        return;
      }
      useViewerStore.getState().closeChatInfo();
      void openApp(appId, { conversationId });
    },
    [activeAssistantId, assistantId, conversationId, openApp],
  );

  const handleOpenFile = useCallback(
    (file: ConversationFileAsset) => {
      if (file.kind === "document") {
        void openDocument(file.doc.surfaceId);
        return;
      }
      // The modal sits above the panel, so the panel stays open behind it.
      openPreview(file.attachment, previewIndexById.get(file.id));
    },
    [openDocument, openPreview, previewIndexById],
  );

  const categoryTitles: Record<ChatInfoCategory, string> = {
    apps: t("chatInfoPanel.appsTitle"),
    files: t("chatInfoPanel.filesTitle"),
    frames: t("chatInfoPanel.framesTitle"),
  };
  const categoryLists = { apps, files, frames };
  const categorySources: Record<ChatInfoCategory, ConversationAssetSource[]> = {
    apps: ["apps"],
    files: ["documents", "attachments"],
    frames: ["frames"],
  };
  const sourceNames = {
    apps: t("chatInfoPanel.appsTitle"),
    documents: t("chatInfoPanel.documentsSource"),
    attachments: t("chatInfoPanel.attachmentsSource"),
    frames: t("chatInfoPanel.framesTitle"),
  };
  const sourceNotices = (category: ChatInfoCategory) =>
    categorySources[category].map((source) => {
      const state = sources[source];
      const name = sourceNames[source];
      if (!state.supported) {
        return (
          <DetailShellNotice key={source} placement="section">
            {t("chatInfoPanel.framesUnsupported")}
          </DetailShellNotice>
        );
      }
      if (state.failure) {
        const messageKey =
          state.failure === "page"
            ? "chatInfoPanel.sourcePageFailed"
            : state.failure === "refresh"
              ? "chatInfoPanel.sourceRefreshFailed"
              : "chatInfoPanel.sourceLoadFailed";
        return (
          <Notice
            key={source}
            // A failed refresh or next page still shows what loaded, so it
            // warns; a source with nothing to show has failed.
            tone={state.hasData ? "warning" : "error"}
            actions={
              (!allFailed || level !== null) && (
                <Button
                  variant="outlined"
                  size="compact"
                  disabled={state.fetching}
                  onClick={() => retrySource(source)}
                  aria-label={t("chatInfoPanel.retrySourceAria", {
                    source: name,
                  })}
                >
                  {t("chatInfoPanel.retry")}
                </Button>
              )
            }
          >
            {t(messageKey, { source: name })}
          </Notice>
        );
      }
      if (state.pending) {
        return (
          <DetailShellLoading
            key={source}
            placement="section"
            label={t("chatInfoPanel.sourceLoading", { source: name })}
          />
        );
      }
      if (state.scope === "loaded-history") {
        return (
          <Fragment key={source}>
            <DetailShellNotice placement="section">
              {t("chatInfoPanel.loadedHistory")}
            </DetailShellNotice>
            <DetailShellNotice placement="section">
              {t("chatInfoPanel.framesUnsupported")}
            </DetailShellNotice>
          </Fragment>
        );
      }
      return null;
    });

  // A category emptied while drilled in (the last app deleted) falls back to
  // the top level rather than rendering an empty page. Only once the sources
  // are ready: a category not loaded yet is empty for a different reason.
  const emptiedCategory =
    payload.category !== null &&
    summarizeAssetSources(
      categorySources[payload.category].map((source) => sources[source]),
    ).status === "ready" &&
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
    if (
      items.length === 0 &&
      categorySources[category].every(
        (source) => !sources[source].pending && !sources[source].failure,
      )
    ) {
      return null;
    }
    return (
      <ChatInfoFileRow
        category={category}
        title={categoryTitles[category]}
        count={countsExact[category] ? counts[category] : null}
        notice={sourceNotices(category)}
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
        hasMore={
          (level === "files" ? hasMoreFiles : hasMoreFrames) &&
          !sources[level === "files" ? "attachments" : "frames"].failure
        }
        loading={sources[level === "files" ? "attachments" : "frames"].fetching}
        onLoadMore={level === "files" ? loadMoreFiles : loadMoreFrames}
        onOpen={handleOpenFile}
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-5">
        {status === "ready" && count === 0 && (
          <DetailShellNotice placement="panel">
            {t("chatInfoPanel.empty")}
          </DetailShellNotice>
        )}
        {(apps.length > 0 || sources.apps.pending || sources.apps.failure) && (
          <ChatInfoSection
            title={categoryTitles.apps}
            count={countsExact.apps ? counts.apps : null}
            notice={sourceNotices("apps")}
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
          title: countsExact[level] ? undefined : categoryTitles[level],
          titleNode: countsExact[level] ? (
            <DetailShellTitleWithCount
              title={categoryTitles[level]}
              count={counts[level]}
            />
          ) : undefined,
        };

  return (
    <DetailShell
      {...headerProps}
      closeLabel={t("chatInfoPanel.closeAria")}
      closeTooltip={t("chatInfoPanel.closeAria")}
      onClose={onClose}
    >
      {level === null && allFailed && (
        <Notice
          tone="error"
          actions={
            <Button
              variant="outlined"
              size="compact"
              disabled={Object.values(sources).some(
                (source) => source.fetching,
              )}
              onClick={retryFailedSources}
            >
              {t("chatInfoPanel.retry")}
            </Button>
          }
        >
          {t("chatInfoPanel.loadFailed")}
        </Notice>
      )}
      {level !== null && sourceNotices(level)}
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

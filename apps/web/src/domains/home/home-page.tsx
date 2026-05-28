import { useCallback, useState } from "react";

import { ResizablePanel } from "@vellum/design-library";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { HomeDetailPanel } from "./detail-panel/home-detail-panel";
import { HomeFeedList } from "./home-feed-list";
import { HomeGreetingHeader } from "./home-greeting-header";
import { HomeSuggestionPillBar } from "./home-suggestion-pill-bar";
import { useHomeFeedQuery } from "./hooks/use-home-feed-query";
import { useHomeStateQuery } from "./hooks/use-home-state-query";
import type { FeedItem, FeedItemStatus, SuggestedPrompt } from "./types";

function HomePageSkeleton() {
  return (
    <div className="flex flex-col gap-[var(--app-spacing-xl)]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--app-spacing-md)]">
          <div className="size-9 animate-pulse rounded-full bg-[var(--surface-lift)]" />
          <div className="h-7 w-64 animate-pulse rounded-md bg-[var(--surface-lift)]" />
        </div>
        <div className="h-9 w-28 animate-pulse rounded-md bg-[var(--surface-lift)]" />
      </div>

      <div className="flex gap-2">
        <div className="h-8 w-36 animate-pulse rounded-full bg-[var(--surface-lift)]" />
        <div className="h-8 w-28 animate-pulse rounded-full bg-[var(--surface-lift)]" />
        <div className="h-8 w-32 animate-pulse rounded-full bg-[var(--surface-lift)]" />
      </div>

      <div className="flex flex-col gap-[var(--app-spacing-sm)]">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-md bg-[var(--surface-lift)]"
          />
        ))}
      </div>
    </div>
  );
}

export interface HomePageProps {
  assistantId: string;
  validConversationIds: Set<string>;
  onStartNewChat: () => void;
  onOpenConversation: (conversationId: string) => void;
  onSuggestionSelected: (prompt: string) => void;
}

export function HomePage({
  assistantId,
  validConversationIds,
  onStartNewChat,
  onOpenConversation,
  onSuggestionSelected,
}: HomePageProps) {
  const isMobile = useIsMobile();
  const avatar = useAssistantAvatar(assistantId);
  const feedQuery = useHomeFeedQuery(assistantId);
  useHomeStateQuery(assistantId);

  const [selectedItem, setSelectedItem] = useState<FeedItem | null>(null);

  const handleSelectItem = useCallback((item: FeedItem) => {
    setSelectedItem(item);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedItem(null);
  }, []);

  const handleDismissItem = useCallback(
    (itemId: string) => {
      feedQuery.updateStatus.mutate({ itemId, status: "dismissed" });
      if (selectedItem?.id === itemId) {
        setSelectedItem(null);
      }
    },
    [feedQuery.updateStatus, selectedItem?.id],
  );

  const handleRestoreItem = useCallback(
    (itemId: string) => {
      feedQuery.updateStatus.mutate({ itemId, status: "seen" });
      setSelectedItem((prev) =>
        prev?.id === itemId ? { ...prev, status: "seen" } : prev,
      );
    },
    [feedQuery.updateStatus],
  );

  const handleUpdateStatus = useCallback(
    (itemId: string, status: FeedItemStatus) => {
      feedQuery.updateStatus.mutate({ itemId, status });
      setSelectedItem((prev) =>
        prev?.id === itemId ? { ...prev, status } : prev,
      );
    },
    [feedQuery.updateStatus],
  );

  const handleGoToThread = useCallback(
    (conversationId: string) => {
      setSelectedItem(null);
      onOpenConversation(conversationId);
    },
    [onOpenConversation],
  );

  const handleSuggestionSelect = useCallback(
    (prompt: SuggestedPrompt) => {
      onSuggestionSelected(prompt.prompt);
    },
    [onSuggestionSelected],
  );

  const feedContent = feedQuery.isLoading ? (
    <HomePageSkeleton />
  ) : (
    <>
      <HomeGreetingHeader
        avatarComponents={avatar.components}
        avatarTraits={avatar.traits}
        avatarImageUrl={avatar.customImageUrl}
        greeting={feedQuery.data?.contextBanner?.greeting}
        isMobile={isMobile}
        onStartNewChat={onStartNewChat}
      />
      {feedQuery.isError ? (
        <div
          role="alert"
          className="rounded-md border border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)] px-[var(--app-spacing-lg)] py-[var(--app-spacing-md)] text-[var(--system-negative-strong)]"
        >
          Couldn't load home feed
          {feedQuery.error instanceof Error
            ? `: ${feedQuery.error.message}`
            : "."}
        </div>
      ) : null}
      <HomeSuggestionPillBar
        suggestions={feedQuery.data?.suggestedPrompts ?? []}
        maxVisible={isMobile ? 2 : 3}
        onSelect={handleSuggestionSelect}
      />
      <HomeFeedList
        items={feedQuery.data?.items ?? []}
        validConversationIds={validConversationIds}
        onSelectItem={handleSelectItem}
        onDismissItem={handleDismissItem}
        onRestoreItem={handleRestoreItem}
        onToggleRead={handleUpdateStatus}
        onGoToThread={handleGoToThread}
      />
    </>
  );

  if (selectedItem && isMobile) {
    return (
      <div
        className="fixed inset-0 z-30 bg-[var(--surface-overlay)]"
        style={{
          paddingTop:
            "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
          paddingBottom:
            "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
        }}
      >
        <HomeDetailPanel
          item={selectedItem}
          isMobile
          validConversationIds={validConversationIds}
          onClose={handleCloseDetail}
          onGoToThread={handleGoToThread}
          onUpdateStatus={handleUpdateStatus}
          onDismiss={handleDismissItem}
        />
      </div>
    );
  }

  if (selectedItem && !isMobile) {
    return (
      <ResizablePanel
        storageKey="homeDetailPanelWidth"
        defaultLeftPercent={50}
        minLeftWidth={400}
        minRightWidth={320}
        left={
          <div className="flex h-full flex-col gap-[var(--app-spacing-xl)] overflow-y-auto px-[var(--app-spacing-xl)] py-[var(--app-spacing-xxl)]">
            {feedContent}
          </div>
        }
        right={
          <HomeDetailPanel
            item={selectedItem}
            validConversationIds={validConversationIds}
            onClose={handleCloseDetail}
            onGoToThread={handleGoToThread}
            onUpdateStatus={handleUpdateStatus}
            onDismiss={handleDismissItem}
          />
        }
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[960px] px-[var(--app-spacing-xl)] py-[var(--app-spacing-xxl)]">
        <div className="flex flex-col gap-[var(--app-spacing-xl)]">
          {feedContent}
        </div>
      </div>
    </div>
  );
}

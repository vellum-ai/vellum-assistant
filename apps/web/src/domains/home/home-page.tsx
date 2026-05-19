import { useCallback, useState } from "react";

import { ResizablePanel } from "@vellum/design-library";
import { useAssistantAvatar } from "@/domains/avatar/use-assistant-avatar.js";
import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { HomeDetailPanel } from "./detail-panel/home-detail-panel.js";
import { HomeFeedList } from "./home-feed-list.js";
import { HomeGreetingHeader } from "./home-greeting-header.js";
import { HomeSuggestionPillBar } from "./home-suggestion-pill-bar.js";
import { useHomeFeedQuery } from "./hooks/use-home-feed-query.js";
import { useHomeStateQuery } from "./hooks/use-home-state-query.js";
import type { FeedItem, FeedItemStatus, SuggestedPrompt } from "./types.js";

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
  onStartNewChat: () => void;
  onOpenConversation: (conversationId: string) => void;
  onSuggestionSelected: (prompt: string) => void;
}

export function HomePage({
  assistantId,
  onStartNewChat,
  onOpenConversation,
  onSuggestionSelected,
}: HomePageProps) {
  const isMobile = useIsMobile();
  const avatar = useAssistantAvatar(assistantId);
  const feedQuery = useHomeFeedQuery(assistantId);
  useHomeStateQuery(assistantId);

  const [selectedItem, setSelectedItem] = useState<FeedItem | null>(null);

  const handleSelectItem = useCallback(
    (item: FeedItem) => {
      if (item.status === "new") {
        setSelectedItem({ ...item, status: "seen" });
        feedQuery.updateStatus.mutate({ itemId: item.id, status: "seen" });
      } else {
        setSelectedItem(item);
      }
    },
    [feedQuery.updateStatus],
  );

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
        onStartNewChat={onStartNewChat}
      />
      <HomeSuggestionPillBar
        suggestions={feedQuery.data?.suggestedPrompts ?? []}
        onSelect={handleSuggestionSelect}
      />
      <HomeFeedList
        items={feedQuery.data?.items ?? []}
        onSelectItem={handleSelectItem}
        onDismissItem={handleDismissItem}
      />
    </>
  );

  if (selectedItem && isMobile) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-30 h-[100dvh]">
        <HomeDetailPanel
          item={selectedItem}
          onClose={handleCloseDetail}
          onGoToThread={handleGoToThread}
          onUpdateStatus={handleUpdateStatus}
        />
      </div>
    );
  }

  if (selectedItem && !isMobile) {
    return (
      <ResizablePanel
        storageKey="homeDetailPanelWidth"
        defaultLeftWidth={600}
        minLeftWidth={400}
        minRightWidth={320}
        left={
          <div className="flex h-full flex-col gap-[var(--app-spacing-xl)] overflow-y-auto px-[var(--app-spacing-xl)] py-[var(--app-spacing-2xl)]">
            {feedContent}
          </div>
        }
        right={
          <HomeDetailPanel
            item={selectedItem}
            onClose={handleCloseDetail}
            onGoToThread={handleGoToThread}
            onUpdateStatus={handleUpdateStatus}
          />
        }
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-[960px] px-[var(--app-spacing-xl)] py-[var(--app-spacing-2xl)]">
      <div className="flex flex-col gap-[var(--app-spacing-xl)]">
        {feedContent}
      </div>
    </div>
  );
}

/**
 * Empty-state data for the chat — greeting text, conversation-starter
 * chips, and the avatar render function.
 *
 * Composes two TanStack Query hooks (`useConversationStarters` and
 * `useEmptyStateGreeting`) and handles the app-editing override where
 * the greeting and starters are derived from the opened app instead of
 * the daemon.
 */

import { type ReactNode, useMemo } from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { ChatEmptyStateProps } from "@/domains/chat/components/chat-empty-state";
import { ConversationStarterGrid } from "@/domains/chat/components/conversation-starter-grid";
import {
  SuggestionFeaturedRow,
  SuggestionGroups,
} from "@/domains/chat/components/suggestion-library";
import { useConversationStarters } from "@/domains/chat/hooks/use-conversation-starters";
import { useEmptyStateGreeting } from "@/domains/chat/hooks/use-empty-state-greeting";
import { useThreadSuggestions } from "@/domains/chat/hooks/use-thread-suggestions";
import { buildEditAppGreeting, buildEditAppStarters } from "@/domains/chat/utils/edit-app-empty-state";
import { pickRandomPlaceholder } from "@/domains/chat/utils/empty-state-constants";
import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";
import type { ThreadSuggestion } from "@/domains/chat/suggestions/types";
import type { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

// ---------------------------------------------------------------------------
// Params & return type
// ---------------------------------------------------------------------------

export interface UseChatEmptyStateParams {
  assistantId: string | null;
  /** Active empty conversation id — a change regenerates the greeting. */
  conversationId: string | null | undefined;
  isEmptyConversation: boolean;
  avatar: ReturnType<typeof useAssistantAvatar>;
  /** Current main view from viewer-store. */
  mainView: string;
  /** Opened app state from viewer-store (non-null when editing an app). */
  openedAppState: { name: string; dirName?: string } | null;
  isAssistantStreaming: boolean;
  isAssistantBusy: boolean;
  activeConversationIsProcessing: boolean;
  onSelectStarter: (starter: ConversationStarter) => void;
  /**
   * Behind the new-thread-suggestions flag, clicking a library card invokes
   * this to open the detail drawer. The library only renders when this is
   * provided; otherwise the empty state falls back to the starter chips.
   */
  onSelectSuggestion?: (suggestion: ThreadSuggestion) => void;
}

export interface ChatEmptyStateResult {
  emptyStateProps: ChatEmptyStateProps;
  startersSlot: ReactNode | undefined;
  /**
   * Below-the-fold content rendered after the first viewport on the empty
   * state. Set to the categorized suggestion groups when the library is
   * shown; otherwise `undefined`.
   */
  belowFoldSlot: ReactNode | undefined;
  /**
   * When true, the empty state docks `startersSlot` to the bottom of the
   * first viewport and centers the greeting + composer above it (the
   * suggestions-library layout). Otherwise the starters sit directly below
   * the composer (the conversation-starter chip layout).
   */
  dockStartersToBottom: boolean;
  renderAvatar: (() => ReactNode) | undefined;
  emptyStatePlaceholder: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatEmptyState({
  assistantId,
  conversationId,
  isEmptyConversation,
  avatar,
  mainView,
  openedAppState,
  isAssistantStreaming: _isAssistantStreaming,
  isAssistantBusy,
  activeConversationIsProcessing: _activeConversationIsProcessing,
  onSelectStarter,
  onSelectSuggestion,
}: UseChatEmptyStateParams): ChatEmptyStateResult {
  const { components: avatarComponents, traits: avatarTraits, customImageUrl: avatarImageUrl } = avatar;

  const newThreadSuggestionsEnabled =
    useClientFeatureFlagStore.use.newThreadSuggestions();
  // Cheap memoized hook — safe to call unconditionally; the result is only
  // rendered on the flag-on path below.
  const { featured, groups } = useThreadSuggestions();

  const emptyStatePlaceholder = useMemo(() => pickRandomPlaceholder(), []);
  const { greeting: emptyStateGreeting, isGenerating: greetingIsGenerating } =
    useEmptyStateGreeting({
      assistantId,
      conversationId,
      enabled: isEmptyConversation,
    });

  const editingApp =
    mainView === "app-editing" && openedAppState
      ? { name: openedAppState.name, dirName: openedAppState.dirName }
      : null;

  // Behind the flag, the new suggestions library replaces the starter chips
  // on a fresh thread. The app-editing override keeps its bespoke chips
  // regardless of the flag, so it stays on the grid path. The library also
  // needs `onSelectSuggestion` to open its detail drawer; without it we fall
  // back to the chip grid.
  const showSuggestionLibrary =
    newThreadSuggestionsEnabled &&
    isEmptyConversation &&
    !editingApp &&
    onSelectSuggestion != null;

  // Gate the daemon fetch by `isEmptyConversation` so non-empty chats stop
  // polling for data that's never rendered. Also skip it whenever the
  // suggestions library is shown — the daemon GET enqueues starter generation
  // and polls every few seconds for chips the library path never renders.
  const { starters: conversationStarters } = useConversationStarters(
    isEmptyConversation && !showSuggestionLibrary ? assistantId : null,
  );

  const emptyStateProps: ChatEmptyStateProps = {
    avatarSlot:
      avatarComponents || avatarImageUrl ? (
        <ChatAvatar
          components={avatarComponents}
          traits={avatarTraits}
          customImageUrl={avatarImageUrl}
          size={40}
          interactive
          isProcessing={isAssistantBusy}
        />
      ) : null,
    greeting: editingApp ? buildEditAppGreeting(editingApp) : emptyStateGreeting,
    isGenerating: editingApp ? false : greetingIsGenerating,
  };

  const emptyStateStarters = editingApp
    ? buildEditAppStarters(editingApp)
    : conversationStarters;

  let startersSlot: ReactNode | undefined;
  let belowFoldSlot: ReactNode | undefined;
  if (showSuggestionLibrary) {
    // `onSelectSuggestion` is non-null here (it's part of the
    // `showSuggestionLibrary` predicate above).
    startersSlot = (
      <SuggestionFeaturedRow featured={featured} onSelect={onSelectSuggestion} />
    );
    belowFoldSlot = (
      <SuggestionGroups groups={groups} onSelect={onSelectSuggestion} />
    );
  } else if (isEmptyConversation && emptyStateStarters.length > 0) {
    startersSlot = (
      <div className="mt-4">
        <ConversationStarterGrid
          starters={emptyStateStarters}
          onSelect={onSelectStarter}
        />
      </div>
    );
  }

  // Stable callback so the latest-turn avatar slot isn't rebuilt on every
  // transcript render. Paired with `memo(ChatAvatar)`, the avatar
  // re-renders only when its inputs actually change.
  const renderAvatar = useMemo(
    () =>
      avatarComponents || avatarImageUrl
        ? () => (
            <ChatAvatar
              components={avatarComponents}
              traits={avatarTraits}
              customImageUrl={avatarImageUrl}
              size={56}
              interactive
              isStreaming={isAssistantBusy}
              isProcessing={false}
            />
          )
        : undefined,
    [
      avatarComponents,
      avatarImageUrl,
      avatarTraits,
      isAssistantBusy,
    ],
  );

  return {
    emptyStateProps,
    startersSlot,
    belowFoldSlot,
    dockStartersToBottom: showSuggestionLibrary,
    renderAvatar,
    emptyStatePlaceholder,
  };
}

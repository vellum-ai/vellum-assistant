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
import { ComposerPeek } from "@/domains/chat/components/composer-peek";
import { ConversationStarterGrid } from "@/domains/chat/components/conversation-starter-grid";
import {
  SuggestionFeaturedRow,
  SuggestionGroups,
} from "@/domains/chat/components/suggestion-library";
import { useConversationStarters } from "@/domains/chat/hooks/use-conversation-starters";
import { useEmptyStateGreeting } from "@/domains/chat/hooks/use-empty-state-greeting";
import { useThreadSuggestions } from "@/domains/chat/hooks/use-thread-suggestions";
import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  buildEditAppGreeting,
  buildEditAppStarters,
} from "@/domains/chat/utils/edit-app-empty-state";
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
  isAssistantBusy: boolean;
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
  /**
   * The composer's hover peek for the empty state (see `ComposerPeek`):
   * mount it once alongside the chat body. `undefined` outside the plain
   * empty state (active conversation, app editing).
   */
  composerPeekSlot: ReactNode | undefined;
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
  isAssistantBusy,
  onSelectStarter,
  onSelectSuggestion,
}: UseChatEmptyStateParams): ChatEmptyStateResult {
  const {
    components: avatarComponents,
    traits: avatarTraits,
    customImageUrl: avatarImageUrl,
  } = avatar;

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

  // The avatar's presence on the empty state lives entirely in
  // `ComposerPeek` (hanging from the top of the screen while idle in the
  // browser, saying hello from under the input on iOS, peeking behind the
  // input while it's focused on both). The greeting headline renders
  // alone.
  // Not during a live-voice session. The peek is anchored to the composer's
  // input rect, and a session replaces that input with the voice surface, so
  // the avatar it hangs has nothing left to peek out from. On mobile it is
  // worse than pointless: the peek is a `fixed` full-viewport portal, so its
  // top-of-screen avatar dangles into the band above the voice sheet, which is
  // the one part of the screen the sheet deliberately leaves to the thread
  // header.
  const liveVoiceState = useLiveVoiceStore.use.state();
  const actsEnabled =
    isEmptyConversation && !editingApp && !isLiveVoiceSessionActive(liveVoiceState);

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
    greeting: editingApp
      ? buildEditAppGreeting(editingApp)
      : emptyStateGreeting,
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
      <SuggestionFeaturedRow
        featured={featured}
        onSelect={onSelectSuggestion}
      />
    );
    belowFoldSlot = (
      <SuggestionGroups groups={groups} onSelect={onSelectSuggestion} />
    );
  } else if (isEmptyConversation && emptyStateStarters.length > 0) {
    if (editingApp) {
      // The app-editing side panel keeps its bespoke chips inline under
      // the composer.
      startersSlot = (
        <div className="mt-4">
          <ConversationStarterGrid
            starters={emptyStateStarters}
            onSelect={onSelectStarter}
          />
        </div>
      );
    } else {
      // Plain empty state: the chips dock to the bottom of the first
      // viewport in a subtle panel with a muted caption (Figma: New-App
      // 7471-25035; the Figma's 1×3 row stays a 2×2 grid here). Top
      // corners only, and `-mb-3` swallows the dock wrapper's bottom
      // padding so the panel sits flush against the viewport's bottom
      // edge.
      startersSlot = (
        <div className="-mb-3 rounded-t-2xl bg-[var(--surface-active)] px-6 pt-5 pb-6">
          <p className="mb-4 text-center text-body-medium-default text-[var(--content-tertiary)]">
            Suggestions
          </p>
          <ConversationStarterGrid
            starters={emptyStateStarters}
            onSelect={onSelectStarter}
          />
        </div>
      );
    }
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
              isAssistantBusy={isAssistantBusy}
              // The latest-turn avatar below the most recent assistant
              // response — the room's entrance grows from here in a
              // conversation.
              originAnchor
            />
          )
        : undefined,
    [avatarComponents, avatarImageUrl, avatarTraits, isAssistantBusy],
  );

  // Portal component — mounting location doesn't matter, but it only runs
  // on the plain empty state (never over the app-editing side panel, whose
  // composer shares the same DOM anchor).
  const composerPeekSlot = actsEnabled ? (
    <ComposerPeek
      components={avatarComponents}
      traits={avatarTraits}
      active={actsEnabled}
    />
  ) : undefined;

  return {
    emptyStateProps,
    startersSlot,
    belowFoldSlot,
    // Both the suggestions library and the plain chip dock pin the
    // starters to the bottom of the first viewport; only the app-editing
    // side panel keeps them inline under the composer.
    dockStartersToBottom:
      showSuggestionLibrary ||
      (isEmptyConversation && !editingApp && emptyStateStarters.length > 0),
    renderAvatar,
    emptyStatePlaceholder,
    composerPeekSlot,
  };
}

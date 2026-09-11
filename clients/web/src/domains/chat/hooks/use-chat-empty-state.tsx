/**
 * Empty-state data for the chat — greeting text, conversation-starter
 * chips, and the avatar render function.
 *
 * Composes two TanStack Query hooks (`useConversationStarters` and
 * `useEmptyStateGreeting`) and handles the app-editing override where
 * the greeting and starters are derived from the opened app instead of
 * the daemon.
 */

import { type ReactNode, useEffect, useMemo } from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { ChatEmptyStateProps } from "@/domains/chat/components/chat-empty-state";
import { ComposerPeek } from "@/domains/chat/components/composer-peek";
import { CreditsUpsellCard } from "@/domains/chat/components/credits-upsell-card";
import { ConversationStarterDock } from "@/domains/chat/components/conversation-starter-dock";
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
import {
  recordAssistantProducesStarters,
  useAssistantProducedStartersAtOpen,
} from "@/domains/chat/utils/starters-availability-storage";
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
  /**
   * Whether the org's credit balance is exhausted (from the shared
   * `useBillingBalanceStatus()` read in `chat-route-content`). While true,
   * the plain empty state mounts the credits upsell card above the starters
   * so a fresh conversation shows the credit wall before the first send.
   * Inert while the billing query is loading or gated off (self-hosted, no
   * platform session), so the card never flashes.
   */
  showCreditsUpsell: boolean;
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
   * first viewport and centers the greeting + composer above it. True for
   * the whole plain empty state (chips and suggestions library alike), from
   * the first frame and regardless of whether starters have arrived, so the
   * composer never moves as the page fills in. Only the app-editing side
   * panel sits false and keeps its bespoke chips directly below the
   * composer.
   */
  dockStartersToBottom: boolean;
  /**
   * True when the docked starters have nothing to show and no reason to hold
   * space: the query settled with no chips for an assistant that is not known
   * to produce any. `ChatBody` keeps the dock mounted and collapses it, so a
   * later answer expands it instead of snapping in.
   */
  startersDockCollapsed: boolean;
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
  showCreditsUpsell,
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
  // Always called unconditionally; only rendered on the flag-on path below.
  // Pass assistantId so the hook can fetch live data with connected-provider
  // statuses; it falls back to the mock catalog until the fetch settles.
  const { featured, groups } = useThreadSuggestions(assistantId);

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

  // The plain chat empty state: a fresh conversation outside the app-editing
  // side panel. Gates the suggestions library, the starters dock, and the
  // proactive credits upsell card.
  const isPlainEmptyState = isEmptyConversation && !editingApp;

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
    isPlainEmptyState && !isLiveVoiceSessionActive(liveVoiceState);

  // Behind the flag, the new suggestions library replaces the starter chips
  // on a fresh thread. The app-editing override keeps its bespoke chips
  // regardless of the flag, so it stays on the grid path. The library also
  // needs `onSelectSuggestion` to open its detail drawer; without it we fall
  // back to the chip grid.
  const showSuggestionLibrary =
    newThreadSuggestionsEnabled &&
    isPlainEmptyState &&
    onSelectSuggestion != null;

  // Gate the daemon fetch by `isEmptyConversation` so non-empty chats stop
  // polling for data that's never rendered. Also skip it whenever the
  // suggestions library is shown — the daemon GET enqueues starter generation
  // and polls every few seconds for chips the library path never renders.
  const startersAssistantId =
    isEmptyConversation && !showSuggestionLibrary ? assistantId : null;
  const {
    starters: conversationStarters,
    status: startersStatus,
    isAwaitingStarters,
  } = useConversationStarters(startersAssistantId);

  // Whether this assistant produced chips the last time it answered. The
  // dock's reserve has to be decided on the first paint, before this launch's
  // query can say, and reserving for an assistant that turns out to have no
  // chips is worse than not reserving at all: the dock takes the space and
  // then gives it back, sliding a screen that would otherwise be still. An
  // assistant nothing is known about therefore reserves nothing, and its
  // first-ever chips open the dock instead of landing in it.
  const assistantProducesStarters =
    useAssistantProducedStartersAtOpen(assistantId);

  // Remember every settled answer for the next launch. Chips in hand say yes
  // whatever the daemon is doing next; only the daemon's own terminal
  // statuses say no, so a failed, paused, or still-generating fetch leaves
  // the previous answer alone rather than forgetting it.
  useEffect(() => {
    if (!startersAssistantId) {
      return;
    }
    if (conversationStarters.length > 0) {
      recordAssistantProducesStarters(startersAssistantId, true);
      return;
    }
    if (startersStatus === "ready" || startersStatus === "empty") {
      recordAssistantProducesStarters(startersAssistantId, false);
    }
  }, [startersAssistantId, startersStatus, conversationStarters.length]);

  const emptyStateProps: ChatEmptyStateProps = {
    greeting: editingApp
      ? buildEditAppGreeting(editingApp)
      : emptyStateGreeting,
    isGenerating: editingApp ? false : greetingIsGenerating,
  };

  const emptyStateStarters = editingApp
    ? buildEditAppStarters(editingApp)
    : conversationStarters;

  // Everything below is about the chip dock and only the chip dock. The
  // suggestions library takes the same docked slot on the flag-on path and
  // fills it from its own data, which the starters query is not even asked
  // for there: reading that silence as an empty dock would collapse the
  // library's featured row out of sight.
  const showStarterDock = isPlainEmptyState && !showSuggestionLibrary;

  // Reserve for an assistant known to produce chips, and keep the reserve up
  // as its own sizing floor once they land so a short answer cannot shrink
  // the dock either. Everything that can end the wait ends the reserve: chips
  // arriving, the daemon settling on none, a failed or paused fetch, and the
  // deadline on a generation that never lands.
  const startersReserved =
    showStarterDock &&
    assistantProducesStarters &&
    (isAwaitingStarters || emptyStateStarters.length > 0);

  // A dock with neither chips nor a reserve has nothing to show. It stays
  // mounted and hands its height back through `ChatBody`'s collapse, which
  // covers the docked column's own padding as well. The credits card rides
  // this same slot, so a dock holding one is never empty.
  const startersDockCollapsed =
    showStarterDock &&
    !startersReserved &&
    !showCreditsUpsell &&
    emptyStateStarters.length === 0;

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
  } else if (
    isEmptyConversation &&
    editingApp &&
    emptyStateStarters.length > 0
  ) {
    // The app-editing side panel keeps its bespoke chips inline under the
    // composer. They are derived from the opened app, so they are ready on
    // the first render and need no reserved space.
    startersSlot = (
      <div className="mt-4">
        <ConversationStarterGrid
          starters={emptyStateStarters}
          onSelect={onSelectStarter}
        />
      </div>
    );
  } else if (showStarterDock) {
    // The chips dock to the bottom of the first viewport in a subtle panel
    // with a muted caption (the Figma's 1×3 row stays a 2×2 grid here). The
    // dock mounts whether or not chips exist yet, so the layout never waits
    // on the daemon to know its shape.
    startersSlot = (
      <ConversationStarterDock
        starters={emptyStateStarters}
        isReserving={startersReserved}
        onSelect={onSelectStarter}
      />
    );
  }

  // Proactive credit wall for a fresh conversation: the card rides the
  // starters slot, ahead of whatever occupies it (or alone when there are no
  // starters yet), so it lands above the starters dock. The empty state
  // suppresses `bannerSlot` (see `chat-body.tsx`), which is why the card
  // mounts here rather than as a banner. The app-editing side panel is
  // excluded; a send there still fails into the in-transcript card.
  if (showCreditsUpsell && isPlainEmptyState) {
    startersSlot = (
      <>
        <div className="mb-3">
          <CreditsUpsellCard />
        </div>
        {startersSlot}
      </>
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

  // Portal component: mounting location doesn't matter, but it only runs
  // on the plain empty state (never over the app-editing side panel, whose
  // composer shares the same DOM anchor) and never during a live-voice
  // session (see `actsEnabled` above).
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
    // Both the suggestions library and the plain chip dock pin the starters
    // to the bottom of the first viewport, from the first frame: the layout
    // does not depend on starters having arrived, so nothing about the
    // composer's position waits on the daemon. Only the app-editing side
    // panel keeps them inline under the composer.
    dockStartersToBottom: showSuggestionLibrary || isPlainEmptyState,
    startersDockCollapsed,
    renderAvatar,
    emptyStatePlaceholder,
    composerPeekSlot,
  };
}

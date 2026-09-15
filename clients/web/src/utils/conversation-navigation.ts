import type { NavigateFunction } from "react-router";

import { haptic } from "@/utils/haptics";
import {
  appIdForPath,
  conversationIdForPath,
  isConversationChatPath,
  routes,
} from "@/utils/routes";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useConversationStore } from "@/stores/conversation-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { isAppMainView } from "@/stores/pane-state";
import { useViewerStore } from "@/stores/viewer-store";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { getSoundManager } from "@/lib/sounds/sound-manager";
import { MOBILE_MEDIA_QUERY } from "@/hooks/use-is-mobile";

/**
 * Navigation as the imperative helpers here call it: a path, optionally
 * replacing the history entry. Narrower than react-router's `NavigateFunction`,
 * which satisfies it, so a caller that only knows how to push a path
 * (the app viewer's action context) satisfies it too.
 */
export type PathNavigate = (
  to: string,
  options?: { replace?: boolean },
) => void | Promise<void>;

export interface NavigateToConversationOptions {
  /** An explicit presentation URL for the same conversation. */
  destination?: string;
  replace?: boolean;
  /** History state for an explicit presentation of this conversation. */
  state?: unknown;
  /** Anchor the transcript to a specific message on load. */
  messageId?: string;
  /**
   * Suppress the haptic tap. For callers that already fired their own haptic
   * at action start (e.g. fork), so the navigation doesn't double-buzz.
   */
  silent?: boolean;
}

/**
 * The route on screen, for the imperative callers here, which hold no hooks.
 * Empty off the browser, where it names neither conversation nor app.
 */
function currentPathname(): string {
  return typeof window === "undefined" ? "" : window.location.pathname;
}

function isNarrowViewport(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

/**
 * If an app is already on screen on a wide viewport, bind `conversationId`
 * as the chat pane and keep the app in the side-by-side layout instead of
 * dismissing it. Returns true when the app was kept.
 *
 * Narrow viewports have no split layout, so those still fall through to
 * chat. Overlay views (document, tool detail, …) are not apps and are
 * dismissed as before.
 */
export function keepOpenAppBesideConversation(conversationId: string): boolean {
  if (isNarrowViewport()) {
    return false;
  }
  const viewer = useViewerStore.getState();
  if (!isAppMainView(viewer.mainView)) {
    return false;
  }
  if (!viewer.activeAppId && !viewer.openedAppState) {
    return false;
  }
  useConversationStore.getState().setEditingConversationId(conversationId);
  viewer.enterAppEditing();
  return true;
}

/**
 * Bring a conversation on screen. An already-open app on a wide viewport
 * stays put in the side-by-side layout; otherwise the viewer returns to chat.
 */
export function revealConversationView(conversationId: string): void {
  if (!keepOpenAppBesideConversation(conversationId)) {
    useViewerStore.getState().setMainView("chat");
  }
}

/**
 * The app the viewer keeps on screen and the URL already names, to carry in
 * the next conversation URL. `null` when the viewer shows the chat or an
 * overlay, and `null` when the URL names no app: a route that unmounts the
 * chat page leaves the viewer holding the app it had, and a store left that
 * way must not put an app back on screen at the next conversation.
 *
 * Read it after `revealConversationView` / `prepareFreshConversation`, which
 * decide whether the app stays. Reads `activeAppId` rather than the loaded
 * `openedAppState`, so an app still loading is already named in the URL.
 */
export function keptAppId(): string | null {
  const viewer = useViewerStore.getState();
  if (!isAppMainView(viewer.mainView) || viewer.activeAppId === null) {
    return null;
  }
  return appIdForPath(currentPathname()) === viewer.activeAppId
    ? viewer.activeAppId
    : null;
}

/**
 * Navigate to an existing conversation, resetting stale viewer state (main
 * view, subagent / workflow panels, transcript side-panel payloads) and
 * updating the active conversation in the store.
 *
 * Pure imperative function — reads stores via `.getState()`, no React hooks.
 */
export function navigateToConversation(
  navigate: NavigateFunction,
  conversationId: string,
  options?: NavigateToConversationOptions,
): void {
  if (!options?.silent) {
    haptic.light();
  }
  // Only wipe per-conversation process state on a genuine switch. Wiping on
  // a same-conversation navigation kills the inline cards for subagents
  // that are still running: the store repopulates only from live SSE
  // events, so the spawned entries can't come back mid-run (LUM-2875).
  //
  // The clear runs first because it settles the chat-info view back to the
  // one the panel was opened from, and the reveal below reads that view.
  if (conversationId !== useConversationStore.getState().activeConversationId) {
    useSubagentStore.getState().reset();
    useWorkflowStore.getState().reset();
    useViewerStore.getState().clearTranscriptPanelPayloads();
  }
  revealConversationView(conversationId);
  useConversationStore.getState().setActiveConversationId(conversationId);
  const destination =
    options?.destination ??
    (options?.messageId
      ? routes.conversationAtMessage(
          conversationId,
          options.messageId,
          keptAppId(),
        )
      : routes.conversation(conversationId, keptAppId()));
  if (options?.replace || options?.state !== undefined) {
    void navigate(destination, {
      ...(options.replace ? { replace: true } : {}),
      ...(options.state !== undefined ? { state: options.state } : {}),
    });
  } else {
    void navigate(destination);
  }
}

/**
 * Mint a draft conversation id, clearing the state the previous conversation
 * leaves behind, which a draft has none of:
 *
 * - **The per-conversation process stores.** Subagent rows and workflow runs
 *   are keyed by run, not by conversation, and they repopulate only from live
 *   SSE. Left behind, the previous conversation's active run renders on the
 *   new chat and its controls (abort, journal) reach the run that is still
 *   going.
 * - **The transcript side-panel payloads.** A files or tool-detail panel is
 *   about one message, and a draft has none of them.
 *
 * Selecting the draft is the caller's, since {@link prepareFreshConversation}
 * brings the chat on screen in between and {@link closeAppRoute} must not.
 */
function mintDraftConversation(): string {
  useSubagentStore.getState().reset();
  useWorkflowStore.getState().reset();
  useViewerStore.getState().clearTranscriptPanelPayloads();
  return createDraftConversationId();
}

/**
 * Mint a fresh draft conversation, select it, and put the surface in the state
 * a new chat expects. Returns the draft's id.
 *
 * On top of what {@link mintDraftConversation} clears, **the chat is brought
 * on screen**: a draft minted behind the fullscreen app viewer has no composer
 * to speak into, and `revealConversationView` keeps an app open beside it on a
 * wide viewport instead of dismissing it.
 *
 * Every entry that opens a fresh conversation for the user to speak into goes
 * through this, so none of them can be missing a piece.
 */
export function prepareFreshConversation(): string {
  const draftId = mintDraftConversation();
  revealConversationView(draftId);
  useConversationStore.getState().setActiveConversationId(draftId);
  return draftId;
}

export interface NavigateToNewConversationOptions {
  silent?: boolean;
  /**
   * Play the new-chat sound. Defaults to true. The in-chat entry (the
   * conversation loader's `startNewConversation`) opts out: it swaps the
   * transcript the user already looks at, so it stays quiet.
   */
  sound?: boolean;
  /** When provided, auto-sends this message in the new conversation. */
  prompt?: string;
}

/**
 * Create a fresh draft conversation and navigate to it.
 *
 * The draft and the state it opens into come from
 * {@link prepareFreshConversation}, shared with every other fresh-conversation
 * entry; all this adds is the navigation. When `silent` is true
 * (e.g. fallback after archiving the active conversation), the haptic tap and
 * the sound are suppressed; `sound: false` drops the sound alone.
 *
 * When `prompt` is provided, the URL includes a `?prompt=` search param that
 * `useAutoSendEffects` picks up to fire the message once the conversation is
 * mounted.
 *
 * Returns the draft's id, for callers that have to address something at the
 * conversation being navigated to before its route mounts (the camera deep
 * link parks a request for that conversation's composer).
 *
 * Pure imperative function — reads stores via `.getState()`, no React hooks.
 */
export function navigateToNewConversation(
  navigate: NavigateFunction,
  options?: NavigateToNewConversationOptions,
): string {
  if (!options?.silent) {
    haptic.light();
    if (options?.sound !== false) {
      void getSoundManager().play("new_conversation");
    }
  }
  const draftId = prepareFreshConversation();

  let path: string = routes.conversation(draftId, keptAppId());
  if (options?.prompt) {
    const params = new URLSearchParams({ prompt: options.prompt });
    path = `${path}?${params.toString()}`;
  }
  void navigate(path);
  requestComposerFocus();
  return draftId;
}

/**
 * Close the app viewer: a navigation to the conversation URL without the app
 * segment. Every close affordance goes through here, so the app leaves the URL
 * and browser Back cannot bring it straight back.
 *
 * The viewer is closed here as well, rather than left to the route sync, so a
 * viewer the URL never named (the Chat Info panel's cross-assistant open)
 * still closes, and the split binding goes with it whichever path closed
 * first.
 *
 * The conversation to land on is the one the route names, then the selected
 * one, and otherwise a fresh draft. The draft skips the reveal: that enters
 * the split and binds the chat pane one frame before this navigation closes
 * everything.
 */
export function closeAppRoute(
  navigate: PathNavigate,
  options?: { replace?: boolean },
): void {
  useViewerStore.getState().closeApp();
  useConversationStore.getState().setEditingConversationId(null);
  let conversationId =
    conversationIdForPath(currentPathname()) ??
    useConversationStore.getState().activeConversationId;
  if (conversationId === null) {
    conversationId = mintDraftConversation();
    useConversationStore.getState().setActiveConversationId(conversationId);
  }
  void navigate(routes.conversation(conversationId), {
    replace: options?.replace === true,
  });
}

/**
 * Follow a link from inside an app. A chat destination leaves the close to the
 * route sync, which sees the app segment disappear from the URL. Any other
 * destination unmounts the chat page along with that sync, so the viewer and
 * its split binding are cleared here instead.
 */
export function navigateFromApp(
  navigate: NavigateFunction,
  href: string,
): void {
  const pathname = href.split("#")[0].split("?")[0];
  if (!isConversationChatPath(pathname)) {
    useViewerStore.getState().closeApp();
    useConversationStore.getState().setEditingConversationId(null);
  }
  void navigate(href);
}

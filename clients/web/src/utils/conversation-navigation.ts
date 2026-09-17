import type { NavigateFunction } from "react-router";

import { autoSendPromptState } from "@/utils/auto-send-prompt";
import { haptic } from "@/utils/haptics";
import {
  appIdForPath,
  conversationIdForPath,
  isConversationChatPath,
  routes,
} from "@/utils/routes";
import { hasAppReturnEntry } from "@/utils/app-navigation";

import { remoteGatewayPublicPathPrefix } from "@/lib/auth/remote-gateway-session";
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
 * A path, optionally replacing the history entry or carrying history state, or
 * a history delta. `NavigateFunction` is one.
 */
export interface PathNavigate {
  (
    to: string,
    options?: { replace?: boolean; state?: unknown },
  ): void | Promise<void>;
  (delta: number): void | Promise<void>;
}

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

/** The route on screen, router-relative like `useLocation().pathname`. */
export function currentPathname(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const { pathname } = window.location;
  const prefix = remoteGatewayPublicPathPrefix();
  return prefix.length > 0 && pathname.startsWith(prefix)
    ? pathname.slice(prefix.length)
    : pathname;
}

/**
 * The history state on the route on screen, for an imperative caller with no
 * `useLocation` of its own. React Router keeps a location's state under `usr`.
 */
export function currentEntryState(): unknown {
  if (typeof window === "undefined") {
    return null;
  }
  return (window.history.state as { usr?: unknown } | null)?.usr ?? null;
}

/** Let go of the app on screen and of the chat pane bound beside it. */
export function clearAppViewer(): void {
  useViewerStore.getState().closeApp();
  useConversationStore.getState().setEditingConversationId(null);
}

/**
 * Clear what belongs to the conversation being left:
 *
 * - **The per-conversation process stores.** Subagent rows and workflow runs
 *   are keyed by run, not by conversation, and they repopulate only from live
 *   SSE. Left behind, the previous conversation's active run renders on the
 *   new chat and its controls (abort, journal) reach the run that is still
 *   going.
 * - **The transcript side-panel payloads.** A files or tool-detail panel is
 *   about one message of the conversation being left.
 */
function resetPerConversationState(): void {
  useSubagentStore.getState().reset();
  useWorkflowStore.getState().reset();
  useViewerStore.getState().clearTranscriptPanelPayloads();
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
 * The app on screen: the one the viewer holds in an app view and the URL
 * already names. `null` for the chat, for an overlay, and for a viewer left
 * holding an app by a route that unmounted the chat page, which shows nobody
 * an app and must not put one back on screen.
 */
function appOnScreenId(): string | null {
  const viewer = useViewerStore.getState();
  if (!isAppMainView(viewer.mainView) || viewer.activeAppId === null) {
    return null;
  }
  return appIdForPath(currentPathname()) === viewer.activeAppId
    ? viewer.activeAppId
    : null;
}

/**
 * If an app is on screen on a wide viewport, bind `conversationId` as the
 * chat pane and keep the app in the side-by-side layout instead of dismissing
 * it. Returns true when the app was kept.
 *
 * Narrow viewports have no split layout, so those still fall through to chat.
 */
export function keepOpenAppBesideConversation(conversationId: string): boolean {
  if (isNarrowViewport() || appOnScreenId() === null) {
    return false;
  }
  useConversationStore.getState().setEditingConversationId(conversationId);
  useViewerStore.getState().enterAppEditing();
  return true;
}

/**
 * Leave the side-by-side split: the app takes the full width back and lets go
 * of the chat pane bound beside it. A no-op anywhere else.
 */
export function exitAppSplit(): void {
  const viewer = useViewerStore.getState();
  if (viewer.mainView !== "app-editing") {
    return;
  }
  viewer.exitAppEditing();
  useConversationStore.getState().setEditingConversationId(null);
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
 * The app to carry in the next conversation URL: {@link appOnScreenId}, read
 * after `revealConversationView` / `prepareFreshConversation`, which decide
 * whether the app stays. Reads `activeAppId` rather than the loaded
 * `openedAppState`, so an app still loading is already named in the URL.
 */
export function keptAppId(): string | null {
  return appOnScreenId();
}

/**
 * Navigate to an existing conversation, resetting the state the conversation
 * being left owns and updating the active conversation in the store.
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
  // Only on a genuine switch: a same-conversation navigation would kill the
  // inline cards for subagents that are still running (LUM-2875). The clear
  // runs first because it settles the chat-info view back to the one the panel
  // was opened from, and the reveal below reads that view.
  if (conversationId !== useConversationStore.getState().activeConversationId) {
    resetPerConversationState();
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
 * Mint a draft conversation id, clearing what the conversation being left owns
 * and a draft has none of. Selecting the draft is the caller's, since
 * {@link prepareFreshConversation} brings the chat on screen in between and
 * {@link closeAppRoute} must not.
 */
function mintDraftConversation(): string {
  resetPerConversationState();
  return createDraftConversationId();
}

/**
 * Mint a fresh draft through {@link mintDraftConversation}, select it, and
 * bring the chat on screen: a draft minted behind the fullscreen app viewer has
 * no composer to speak into, and `revealConversationView` keeps an app open
 * beside it on a wide viewport instead of dismissing it. Returns the draft's
 * id. Every entry that opens a fresh conversation for the user to speak into
 * goes through this, so none of them can be missing a piece.
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
 * When `prompt` is provided, the URL includes a `?prompt=` search param and
 * the navigation carries `autoSendPromptState`, so `useAutoSendEffects` fires
 * the message once the conversation is mounted. The state is what makes it
 * a send rather than a pre-fill: the same URL opened from outside the app
 * only stages the text (see `utils/auto-send-prompt.ts`).
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

  const appId = keptAppId();
  if (options?.prompt) {
    void navigate(
      routes.conversationWithPrompt(draftId, options.prompt, undefined, appId),
      { state: autoSendPromptState() },
    );
  } else {
    void navigate(routes.conversation(draftId, appId));
  }
  requestComposerFocus();
  return draftId;
}

/**
 * Leave the app entry on screen for `target`: back through the entry the open
 * recorded ({@link appEntryState}) when this entry carries that recording, and
 * otherwise a replace of the app's own entry. `forceReplace` takes the replace
 * for a move with no gesture behind it.
 */
function leaveAppEntry(
  navigate: PathNavigate,
  appId: string,
  target: string,
  state: unknown,
  forceReplace: boolean,
): void {
  if (!forceReplace && hasAppReturnEntry(state, appId, target)) {
    void navigate(-1);
    return;
  }
  void navigate(target, { replace: true });
}

/**
 * Close the app viewer: back through the entry the app was opened from when
 * one was recorded there ({@link appEntryState}), and otherwise a replace of
 * the app's own entry. The fallback covers a direct link, a reload that lost
 * the state, an open from the Library, and an app carried in from another
 * conversation. Desktop, compact and Android all take this one decision, so
 * Back reads the same everywhere. `replace` forces the fallback for a close
 * with no gesture behind it (an unpinned app).
 *
 * The viewer is cleared here as well, rather than left to the route sync, so a
 * viewer the URL never named still closes, and the split binding goes with it
 * whichever path closed first.
 *
 * The conversation to land on is the one the route names, then the selected
 * one, and otherwise a fresh draft. The draft skips the reveal: that enters
 * the split and binds the chat pane one frame before this navigation closes
 * everything.
 */
export function closeAppRoute(
  navigate: PathNavigate,
  options?: { state?: unknown; replace?: boolean },
): void {
  const pathname = currentPathname();
  const appId = appIdForPath(pathname);
  clearAppViewer();
  let conversationId =
    conversationIdForPath(pathname) ??
    useConversationStore.getState().activeConversationId;
  if (conversationId === null) {
    conversationId = mintDraftConversation();
    useConversationStore.getState().setActiveConversationId(conversationId);
  }
  const target = routes.conversation(conversationId);
  if (appId === null) {
    void navigate(target, { replace: true });
    return;
  }
  leaveAppEntry(
    navigate,
    appId,
    target,
    options?.state,
    options?.replace === true,
  );
}

/**
 * Follow a link from inside an app. A chat destination the route sync can react
 * to leaves the close to it, which sees the app segment disappear from the URL.
 * Anything else is cleared here: a destination that unmounts the chat page
 * unmounts that sync with it, and an app the URL never named leaves the sync
 * with no segment to lose.
 */
export function navigateFromApp(
  navigate: NavigateFunction,
  href: string,
): void {
  const pathname = href.split("#")[0].split("?")[0];
  if (
    !isConversationChatPath(pathname) ||
    appIdForPath(currentPathname()) === null
  ) {
    clearAppViewer();
  }
  void navigate(href);
}

/**
 * Take `appId`'s segment off the route, landing on the conversation the route
 * names: back through the recorded opening entry when the entry carries one,
 * and otherwise a replace of the app's own entry. A no-op once the URL has
 * moved on to another app. An `activeAppId` still on the app means an overlay
 * holds it, so the URL stands.
 *
 * `evenIfHeld` drops the segment while the viewer still holds the app, for a
 * caller that means the app to stay in memory behind what is in front of it.
 * `replace` forces the replace for a drop with no gesture behind it.
 */
export function dropAppFromRoute(
  navigate: PathNavigate,
  appId: string,
  options?: { evenIfHeld?: boolean; replace?: boolean },
): void {
  if (
    options?.evenIfHeld !== true &&
    useViewerStore.getState().activeAppId === appId
  ) {
    return;
  }
  const pathname = currentPathname();
  if (appIdForPath(pathname) !== appId) {
    return;
  }
  const conversationId = conversationIdForPath(pathname);
  if (conversationId === null) {
    return;
  }
  leaveAppEntry(
    navigate,
    appId,
    routes.conversation(conversationId),
    currentEntryState(),
    options?.replace === true,
  );
}

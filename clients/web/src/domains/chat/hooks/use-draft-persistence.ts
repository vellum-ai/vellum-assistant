/**
 * use-draft-persistence — keep the chat composer draft alive across reloads.
 *
 * The composer's text lives in `composer-store` and is persisted to localStorage
 * only at discrete moments (conversation switch, assistant switch,
 * pull-to-refresh, send). A page reload — Vite HMR full reload, Cmd-R, or app
 * restart — hits none of those, so without this hook the in-progress draft is
 * lost. This hook closes both ends of that gap:
 *
 * - **Debounced autosave** on every input change (survives a crash / force-quit).
 * - **Synchronous flush** on `pagehide` / `visibilitychange` → hidden — the path
 *   a reload actually takes. `visibilitychange` also covers iOS/Capacitor, where
 *   `pagehide` is unreliable.
 * - **Cold-load restore**: when a conversation first becomes active, restore its
 *   saved draft into an empty composer.
 *
 * Drafts are keyed by `activeConversationId`, which is reload-stable: new chats
 * carry a `draft-…` id in the URL and the id is re-derived from the URL on load.
 *
 * Self-contained — reads both stores directly, so it mounts once with no props.
 */

import { useEffect, useRef } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useConversationStore } from "@/stores/conversation-store";

const AUTOSAVE_DEBOUNCE_MS = 300;

export function useDraftPersistence(): void {
  // --- Debounced autosave + unload flush -----------------------------------
  // Registered once; reads the latest state at fire time. Driven by
  // `store.subscribe` (not a reactive selector) so per-keystroke input changes
  // never re-render the host component.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = useComposerStore.subscribe((state, prev) => {
      if (state.input === prev.input) return;
      // Capture key + value at change time so a mid-debounce conversation switch
      // can't mis-file this draft.
      const key = useConversationStore.getState().activeConversationId;
      const value = state.input;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // Only write when this conversation is still active — guards the switch
        // race (never persist conversation B's text under conversation A).
        if (key && useConversationStore.getState().activeConversationId === key) {
          useComposerStore.getState().saveDraft(key, value);
        }
      }, AUTOSAVE_DEBOUNCE_MS);
    });

    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      // previousConversationId stays in sync with the composer's content
      // because switchToConversation updates it after handleConversationSwitch
      // sets the new input. Falls back to activeConversationId for the
      // initial-load case where previousConversationId is still null.
      const key = useChatSessionStore.getState().previousConversationId
        ?? useConversationStore.getState().activeConversationId;
      if (key) {
        useComposerStore.getState().saveDraft(key, useComposerStore.getState().input);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      flush();
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // --- Cold-load restore ---------------------------------------------------
  // On mount, restore the saved draft for the initial conversation. Runs once
  // per component lifecycle — navigation switches are handled by
  // handleConversationSwitch (called from switchToConversation). Limiting to
  // mount prevents restoreDraftIfEmpty from racing with handleConversationSwitch
  // when both fire for the same activeConversationId change.
  const activeConversationId = useConversationStore.use.activeConversationId();
  const didMountRestoreRef = useRef(false);
  useEffect(() => {
    if (!activeConversationId) return;
    if (didMountRestoreRef.current) return;
    didMountRestoreRef.current = true;
    useComposerStore.getState().restoreDraftIfEmpty(activeConversationId);
  }, [activeConversationId]);
}

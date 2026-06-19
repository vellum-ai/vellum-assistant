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
      const key = useConversationStore.getState().activeConversationId;
      if (key) {
        // saveDraft deletes the entry when the text is empty, so clearing the
        // composer then reloading correctly leaves nothing to restore.
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
  // When a conversation first becomes active (page load / navigation), restore
  // its saved draft. `restoreDraftIfEmpty` no-ops when the composer already has
  // text, so this never fights `handleConversationSwitch` (which owns switch-time
  // restore) and never clobbers a deep-link / starter prefill.
  const activeConversationId = useConversationStore.use.activeConversationId();
  const restoredKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeConversationId) return;
    if (restoredKeyRef.current === activeConversationId) return;
    restoredKeyRef.current = activeConversationId;
    useComposerStore.getState().restoreDraftIfEmpty(activeConversationId);
  }, [activeConversationId]);
}

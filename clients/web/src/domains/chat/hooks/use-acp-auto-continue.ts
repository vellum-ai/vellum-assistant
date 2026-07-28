import { useEffect } from "react";

import { useInteractionStore } from "@/domains/chat/interaction-store";

/**
 * Fires `onContinue` exactly once when the inline "Connect Claude Code" card
 * signals it has finished connecting (`pendingAcpContinue`).
 *
 * The card is rendered deep in the transcript and can't reach `sendMessage`
 * (which needs top-level chat context), so it only flips the store flag. This
 * hook lives in the chat view — where `sendMessage` IS available — and turns
 * that flag into a hidden continuation send so the assistant picks the failed
 * task back up without the user typing "retry". Clears the flag before firing
 * so a re-render can't double-send.
 *
 * This is also where the connected card is retired: a normal send no longer
 * dismisses the Connect prompt (it stays until resolved), so the connect →
 * auto-continue path explicitly clears the "connected — continuing..." card
 * here as the task resumes.
 */
export function useAcpAutoContinue(onContinue: () => void): void {
  const pendingAcpContinue = useInteractionStore.use.pendingAcpContinue();

  useEffect(() => {
    if (!pendingAcpContinue) {
      return;
    }
    const store = useInteractionStore.getState();
    store.clearAcpContinue();
    store.dismissAcpConnect();
    onContinue();
  }, [pendingAcpContinue, onContinue]);
}

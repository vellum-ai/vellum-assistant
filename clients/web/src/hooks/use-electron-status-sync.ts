import { useEffect } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { setAssistantStatus } from "@/runtime/status";
import { useAuthStore } from "@/stores/auth-store";
import { useSSEConnectedStore } from "@/stores/sse-connected-store";
import { deriveAssistantStatus } from "@/utils/assistant-status";

/**
 * Publish the assistant's connection status to the Electron host so the main
 * process can drive the menu-bar (Tray) status dot and its thinking pulse.
 * `setAssistantStatus` no-ops on non-Electron hosts (see `@/runtime/status`),
 * so this hook is safe to mount unconditionally.
 *
 * The renderer holds the live lifecycle / auth / SSE / turn signals, so it is
 * the source of truth; the derivation is centralized in `deriveAssistantStatus`
 * and main owns only the presentation. Main de-dupes republished values, so
 * publishing the derived status on every change is cheap.
 *
 * Mounted in `RootLayout` (alongside the favicon/icon sync) rather than the
 * chat layout so the dot keeps tracking lifecycle and connection state on
 * every authenticated route, not only while chat is on screen.
 */
export function useElectronStatusSync(): void {
  const lifecycleKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  const sessionStatus = useAuthStore.use.sessionStatus();
  const isSSEConnected = useSSEConnectedStore.use.isConnected();
  const turnPhase = useTurnStore.use.phase();

  useEffect(() => {
    setAssistantStatus(
      deriveAssistantStatus({
        lifecycleKind,
        sessionStatus,
        isSSEConnected,
        turnPhase,
      }),
    );
  }, [lifecycleKind, sessionStatus, isSSEConnected, turnPhase]);
}

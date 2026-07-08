import { useEffect } from "react";

import { setAssistantName } from "@/runtime/identity";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/**
 * Publish the active assistant's display name to the Electron host so the main
 * process can title the window (Window menu, Cmd-` switcher, Mission Control),
 * the menu-bar (Tray) tooltip / header, and the native About panel with the
 * assistant's name (e.g. "Aria"). `setAssistantName` no-ops on non-Electron
 * hosts (see `@/runtime/identity`), so this hook is safe to mount
 * unconditionally.
 *
 * The renderer's `useAssistantIdentityStore` is the source of truth — hydrated
 * by `useAssistantIdentityInit` from the daemon `/identity` endpoint, SSE
 * `identity_changed`, and the optimistic onboarding seed; main owns only the
 * presentation and de-dupes republished values. Publishing `""` when the name
 * clears lets main fall back to its defaults.
 *
 * Mounted in `RootLayout` (alongside the favicon / icon / status sync) rather
 * than the chat layout so the name tracks every authenticated route, not only
 * while chat is on screen.
 */
export function useElectronIdentitySync(): void {
  const name = useAssistantIdentityStore.use.name();

  useEffect(() => {
    setAssistantName(name ?? "");
  }, [name]);
}

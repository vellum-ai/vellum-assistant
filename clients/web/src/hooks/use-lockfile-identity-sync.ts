import { useEffect } from "react";

import { renameLockfileAssistant } from "@/lib/local-mode";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/**
 * Mirror the active assistant's persona name into its lockfile entry so
 * lockfile consumers (assistant chooser, Electron tray, `vellum pair`) show
 * the live name instead of a stale snapshot.
 *
 * Reads both `name` and `assistantId` from `useAssistantIdentityStore`: the
 * store writes them in one `set()`, so this pairing can never mix a stale
 * name with a new id mid-switch (unlike pairing the name with
 * `activeAssistantId` from the resolved-assistants store).
 *
 * All skip logic (empty name, missing lockfile entry, unchanged name, host
 * unavailable, remote-gateway mode) lives in `renameLockfileAssistant`, so
 * this hook is safe to mount unconditionally in `RootLayout`.
 */
export function useLockfileIdentitySync(): void {
  const name = useAssistantIdentityStore.use.name();
  const assistantId = useAssistantIdentityStore.use.assistantId();

  useEffect(() => {
    if (name !== null && assistantId !== null) {
      void renameLockfileAssistant(assistantId, name);
    }
  }, [name, assistantId]);
}

import { useEffect } from "react";

import {
  renameLockfileAssistant,
  useLockfileAssistantName,
} from "@/lib/local-mode";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const RETRY_DELAY_MS = 2_000;

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
 * Also subscribes to the lockfile entry's own name, so the sync re-fires when
 * the lockfile hydrates after the identity store on boot (the helper no-ops
 * on a missing entry) or the entry's name changes externally. A failed host
 * write gets one delayed retry per effect run; convergence otherwise rides
 * the next dep change.
 *
 * All skip logic (empty name, missing lockfile entry, unchanged name, host
 * unavailable, remote-gateway mode) lives in `renameLockfileAssistant`, so
 * this hook is safe to mount unconditionally in `RootLayout`.
 */
export function useLockfileIdentitySync(retryDelayMs = RETRY_DELAY_MS): void {
  const name = useAssistantIdentityStore.use.name();
  const assistantId = useAssistantIdentityStore.use.assistantId();
  const lockfileName = useLockfileAssistantName(assistantId);

  useEffect(() => {
    if (name === null || assistantId === null) {
      return;
    }
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    void renameLockfileAssistant(assistantId, name).then((converged) => {
      if (converged || disposed) {
        return;
      }
      retryTimer = setTimeout(() => {
        void renameLockfileAssistant(assistantId, name);
      }, retryDelayMs);
    });
    return () => {
      disposed = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
    };
  }, [name, assistantId, lockfileName, retryDelayMs]);
}

import type { QueryClient } from "@tanstack/react-query";

import { setSelectedAssistant } from "@/assistant/selection";
import { forgetAssistantAvatar } from "@/hooks/use-chooser-row-avatar";
import {
  getLockfileAssistant,
  getSelectedAssistant,
  isLocalClient,
  isPairedAssistant,
  loadLockfile,
  removePairedAssistantFromLockfile,
} from "@/lib/local-mode";
import { t } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import {
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

/**
 * Host-command (tray, command palette) entry points for switching to and
 * removing assistants by id, so the paired-vs-managed routing is testable
 * without mounting the app shell.
 */

export type SwitchOutcome = { ok: true } | { ok: false; error: string };

/**
 * Switch to an assistant by id. A paired entry needs the paired connect flow
 * (host-authorized gateway proxy setup); the bare selection write
 * would record it active without credentials. Everything else goes through
 * the platform selection path; local assistants never reach this handler
 * (the tray and palette exclude them).
 */
export async function switchToAssistant(
  assistantId: string,
): Promise<SwitchOutcome> {
  let entry = getLockfileAssistant(assistantId);
  if (!entry) {
    // The renderer cache can trail main's watched lockfile (e.g. a
    // `vellum connect import` while the app was open). Reload before
    // treating the id as managed, or a fresh paired entry would be
    // selected without credentials.
    await loadLockfile();
    entry = getLockfileAssistant(assistantId);
  }
  if (entry && isPairedAssistant(entry)) {
    try {
      await useAuthStore.getState().connectPairedAssistant(assistantId);
    } catch (err) {
      console.error("switchToAssistant.connectPairedAssistant failed", err);
      return { ok: false, error: t("assistantConnect.failed") };
    }
    return { ok: true };
  }
  await setSelectedAssistant(assistantId);
  return { ok: true };
}

/**
 * Switch to a resolved assistant through the connect entry its kind needs,
 * mirroring the chooser screen's dispatch: a paired entry primes the
 * host-authorized proxy, a local entry on a local client primes a gateway
 * token for its gateway, and everything else (platform-hosted, or a
 * hub-listed local entry reached through the platform) goes through the
 * platform session path.
 *
 * Unlike {@link switchToAssistant}, which serves id-only host commands whose
 * surfaces exclude local entries, this rethrows so UI callers can surface the
 * failure. Every connect entry fails before the selection write, so a failed
 * switch leaves the previous assistant intact.
 */
export async function switchToResolvedAssistant(
  assistant: ResolvedAssistant,
): Promise<void> {
  const auth = useAuthStore.getState();
  if (assistant.isPaired) {
    await auth.connectPairedAssistant(assistant.id);
    return;
  }
  if (assistant.isLocal && isLocalClient()) {
    await auth.connectLocalAssistant(assistant.id);
    return;
  }
  await auth.connectPlatformAssistant(assistant.id);
}

export type RemovePairedOutcome =
  | { ok: true; nextRoute: string | null }
  | { ok: false; error: string };

/**
 * Forget a paired assistant on this device, with full renderer cleanup: the
 * host removes the entry + stored guardian token, the lockfile helper clears
 * the session residue (selection key, gateway token, self-hosted connection),
 * and the lifecycle's active id is dropped so a stale connection can't be
 * admitted. When the removed entry was the effective selection the caller
 * should route to the chooser (`nextRoute`); otherwise stay put (`null`).
 */
export async function removePairedAssistant(
  queryClient: QueryClient,
  assistantId: string,
): Promise<RemovePairedOutcome> {
  const wasSelected = getSelectedAssistant()?.assistantId === assistantId;
  let result: Awaited<ReturnType<typeof removePairedAssistantFromLockfile>>;
  try {
    result = await removePairedAssistantFromLockfile(assistantId);
  } catch (err) {
    console.error("removePairedAssistant.removeFromLockfile failed", err);
    return { ok: false, error: "Failed to remove assistant." };
  }
  if (!result.ok) {
    return { ok: false, error: result.error ?? "Failed to remove assistant." };
  }
  forgetAssistantAvatar(queryClient, assistantId);
  const resolvedStore = useResolvedAssistantsStore.getState();
  if (resolvedStore.activeAssistantId === assistantId) {
    resolvedStore.setActiveAssistantId(null);
  }
  return {
    ok: true,
    nextRoute: wasSelected ? `${routes.selectAssistant}?noAutoSkip=1` : null,
  };
}

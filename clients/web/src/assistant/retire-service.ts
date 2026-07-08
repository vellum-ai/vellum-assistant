import { listAssistants, retireAssistantById } from "@/assistant/api";
import {
  getLockfile,
  isLocalAssistant,
  isLocalMode,
  retireLocalAssistant,
  syncPlatformAssistantsToLockfile,
} from "@/lib/local-mode";
import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { clearResearchSnapshot } from "@/domains/onboarding/research-onboarding-persistence";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

/**
 * Outcome of a retire attempt. On success carries the route the caller should
 * navigate to; navigation and toasts are left to the caller (a hook-free
 * service can't own routing). On failure carries a user-facing message.
 */
export type RetireOutcome =
  | { ok: true; nextRoute: string }
  | { ok: false; error: string };

/**
 * Resolve where to send the user after a retire. Reads `hasAssistants`
 * from the resolved assistants store (already updated via `remove()`
 * before this runs) and delegates to the navigation resolver.
 */
function getPostRetireRoute(): string {
  const decision = resolveNavigation(buildNavigationState(), {
    kind: "post-retire",
  });
  return decision.action === "redirect"
    ? decision.to
    : routes.welcome;
}

/**
 * Retire the assistant identified by `assistantId`.
 *
 * Routes local vs platform by the **target** assistant's type — the entry in
 * the lockfile with this id — rather than the currently selected assistant.
 * This is what lets a caller (e.g. the tray "Retire <assistant>…" command)
 * retire a managed assistant by id correctly, where the previous settings-only
 * flow always assumed the target was the active assistant.
 *
 * On success performs the shared post-retire cleanup (onboarding flags, and a
 * best-effort lockfile platform-sync in local mode) and returns the route the
 * caller should navigate to. Never throws — failures come back as
 * `{ ok: false, error }`.
 */
export async function retireAssistant(
  assistantId: string,
): Promise<RetireOutcome> {
  try {
    const target = getLockfile().assistants.find(
      (a) => a.assistantId === assistantId,
    );
    const useLocal = isLocalMode() && !!target && isLocalAssistant(target);

    if (useLocal) {
      const result = await retireLocalAssistant(assistantId);
      if (!result.ok) {
        return {
          ok: false,
          error: result.error || "Failed to retire assistant.",
        };
      }
    } else {
      const result = await retireAssistantById(assistantId);
      // A 404 means the assistant is already gone — treat as success so the
      // local lockfile and onboarding flags still get reconciled.
      if (!(result.ok || result.status === 404)) {
        const detail =
          typeof result.error?.detail === "string"
            ? result.error.detail
            : "Failed to retire assistant.";
        return { ok: false, error: detail };
      }
      if (isLocalMode()) {
        try {
          const remaining = await listAssistants();
          if (remaining.ok) {
            await syncPlatformAssistantsToLockfile(
              remaining.data,
              useOrganizationStore.getState().currentOrganizationId ?? undefined,
            );
          }
        } catch {
          // Best-effort sync — the retire itself already succeeded.
        }
      }
    }

    useResolvedAssistantsStore.getState().remove(assistantId);
    // Retiring ends any in-flight onboarding journey with it: drop the
    // research-onboarding resume snapshot so the next onboarding starts at the
    // form instead of resuming the retired assistant's run deep in the flow
    // (e.g. straight onto the wake gate).
    clearResearchSnapshot(useAuthStore.getState().user?.id ?? null);
    return { ok: true, nextRoute: getPostRetireRoute() };
  } catch {
    return { ok: false, error: "Failed to retire assistant." };
  }
}

import { setActiveLockfileAssistant } from "@/lib/local-mode";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useOrganizationStore } from "@/stores/organization-store";

/**
 * Switch the active platform assistant.
 *
 * Writes the per-org selection — the source `use-lifecycle.ts` resolves the
 * active assistant from when the `multi-platform-assistant` flag is on — and
 * mirrors it into the lockfile `activeAssistant` so the macOS tray, the CLI,
 * and the native client agree (a no-op in the browser, where there is no
 * lockfile host).
 */
export async function selectPlatformAssistant(
  assistantId: string,
): Promise<void> {
  const orgId = useOrganizationStore.getState().currentOrganizationId;
  if (orgId) {
    useResolvedAssistantsStore
      .getState()
      .setSelectedPlatformAssistant(orgId, assistantId);
  }
  await setActiveLockfileAssistant(assistantId);
}

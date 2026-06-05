import { setActiveLockfileAssistant } from "@/lib/local-mode";
import { useCurrentPlatformAssistantStore } from "@/stores/current-platform-assistant-store";
import { useOrganizationStore } from "@/stores/organization-store";

/**
 * Switch the active platform assistant.
 *
 * Writes the per-org selection — the source `use-lifecycle.ts` resolves the
 * active assistant from when the `multi-platform-assistant` flag is on — and
 * mirrors it into the lockfile `activeAssistant` so the macOS tray, the CLI,
 * and the native client agree (a no-op in the browser, where there is no
 * lockfile host).
 *
 * The lifecycle reacts to the per-org store change (it subscribes to `byOrg`)
 * and re-resolves to the selected assistant, so callers don't need to drive
 * the switch imperatively — just record the selection here.
 */
export async function selectPlatformAssistant(
  assistantId: string,
): Promise<void> {
  const orgId = useOrganizationStore.getState().currentOrganizationId;
  if (orgId) {
    useCurrentPlatformAssistantStore
      .getState()
      .setAssistantId(orgId, assistantId);
  }
  await setActiveLockfileAssistant(assistantId);
}

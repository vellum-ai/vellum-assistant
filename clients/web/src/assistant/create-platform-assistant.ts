import { hatchAssistant, listAssistants } from "@/assistant/api";
import { setSelectedAssistant } from "@/assistant/selection";
import { syncPlatformAssistantsToLockfile } from "@/lib/local-mode";
import { useOrganizationStore } from "@/stores/organization-store";
import { extractErrorMessage } from "@/utils/api-errors";

export type CreatePlatformAssistantResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Create a new managed (platform-hosted) assistant and switch to it.
 *
 * Mirrors the native client's "New Assistant" flow: hatch with `mode: "create"`
 * so the platform provisions an *additional* assistant (rather than `ensure`,
 * which hands back the existing one), refresh the lockfile so the new entry is
 * present for the tray/CLI, then select it via `setSelectedAssistant`.
 *
 * The new assistant starts in `initializing`; the lifecycle resolves it to
 * `active` once the platform finishes provisioning. Never throws — failures
 * come back as `{ ok: false, error }`.
 */
export async function createPlatformAssistant(
  name?: string,
): Promise<CreatePlatformAssistantResult> {
  const result = await hatchAssistant(name ? { name } : undefined, "create");
  if (!result.ok) {
    return {
      ok: false,
      error: extractErrorMessage(
        result.error,
        undefined,
        "Failed to create assistant.",
      ),
    };
  }

  // Best-effort: refresh the lockfile so the new assistant shows up for the
  // tray/CLI. The assistant was created regardless of whether this succeeds.
  try {
    const remaining = await listAssistants();
    if (remaining.ok) {
      await syncPlatformAssistantsToLockfile(
        remaining.data,
        useOrganizationStore.getState().currentOrganizationId ?? undefined,
      );
    }
  } catch {
    // non-fatal
  }

  await setSelectedAssistant(result.data.id);
  return { ok: true, id: result.data.id };
}

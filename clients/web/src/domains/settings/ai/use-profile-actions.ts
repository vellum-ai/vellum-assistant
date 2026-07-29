import { toast } from "@vellumai/design-library/components/toast";

import { useLlmConfigPatch } from "@/domains/settings/ai/use-llm-config-patch";
import { captureError } from "@/lib/sentry/capture-error";
import type { ConfigPatchRequest } from "@/generated/daemon/types.gen";

export interface ProfileActions {
  /** Set `llm.activeProfile` - the main-chat default. */
  makeActive: (name: string) => Promise<void>;
  /** Set `llm.advisorProfile` - the second-opinion consult. */
  makeAdvisor: (name: string) => Promise<void>;
  clearAdvisor: () => Promise<void>;
  /** Enable/disable a profile via a deep-merge status patch. */
  setStatus: (name: string, active: boolean) => Promise<void>;
  /**
   * Delete a profile fragment and drop it from `profileOrder`. When the
   * profile is the current advisor, the advisor reference clears in the
   * same patch so no dangling name survives the delete.
   */
  deleteProfile: (
    name: string,
    profileOrder: string[],
    options?: { isAdvisor?: boolean },
  ) => Promise<void>;
  /** Arbitrary `llm` patch used by the blocked-delete reassign step. */
  patchLlm: (
    llm: NonNullable<ConfigPatchRequest["llm"]>,
    errorContext: string,
    errorMessage: string,
  ) => Promise<void>;
  isPending: boolean;
}

/**
 * Kebab-menu mutations for the Profiles section. Everything flows through
 * the universally-understood `PATCH /v1/config` deep-merge (see the gate
 * note in use-supports-inference-profiles.ts); each success refreshes both
 * the config cache and the effective-catalog query so chips and rows agree.
 */
export function useProfileActions(assistantId: string): ProfileActions {
  const configMutation = useLlmConfigPatch(assistantId);

  async function patchLlm(
    llm: NonNullable<ConfigPatchRequest["llm"]>,
    errorContext: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm },
      });
    } catch (error) {
      captureError(error, { context: errorContext });
      toast.error(errorMessage);
      throw error;
    }
  }

  return {
    makeActive: (name) =>
      patchLlm(
        { activeProfile: name },
        "settings-ai-profile-make-active",
        "Failed to set the active profile. Please try again.",
      ),
    makeAdvisor: (name) =>
      patchLlm(
        { advisorProfile: name },
        "settings-ai-profile-make-advisor",
        "Failed to set the advisor profile. Please try again.",
      ),
    clearAdvisor: () =>
      patchLlm(
        { advisorProfile: null },
        "settings-ai-profile-clear-advisor",
        "Failed to clear the advisor profile. Please try again.",
      ),
    setStatus: (name, active) =>
      patchLlm(
        { profiles: { [name]: { status: active ? "active" : "disabled" } } },
        "settings-ai-profile-toggle",
        "Failed to update the profile. Please try again.",
      ),
    deleteProfile: (name, profileOrder, options) =>
      patchLlm(
        {
          profiles: { [name]: null },
          profileOrder: profileOrder.filter((n) => n !== name),
          ...(options?.isAdvisor ? { advisorProfile: null } : {}),
        },
        "settings-ai-profile-delete",
        "Failed to delete the profile. Please try again.",
      ),
    patchLlm,
    isPending: configMutation.isPending,
  };
}

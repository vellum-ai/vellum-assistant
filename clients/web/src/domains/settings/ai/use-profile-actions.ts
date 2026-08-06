import { useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellumai/design-library/components/toast";

import { useLlmConfigPatch } from "@/domains/settings/ai/use-llm-config-patch";
import {
  configGetQueryKey,
  inferenceProfilesGetQueryKey,
  useInferenceActiveprofilePutMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useSupportsActiveProfileRoute } from "@/lib/backwards-compat/use-supports-active-profile-route";
import { badRequestMessage } from "@/utils/api-errors";
import type { ConfigPatchRequest } from "@/generated/daemon/types.gen";

const MAKE_ACTIVE_ERROR_CONTEXT = "settings-ai-profile-make-active";
const MAKE_ACTIVE_ERROR_MESSAGE =
  "Failed to set the active profile. Please try again.";

export interface ProfileActions {
  /** Set `llm.activeProfile` - the main-chat default. */
  makeActive: (name: string) => Promise<void>;
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
 * Kebab-menu mutations for the Profiles section. Status and delete flow
 * through the universally-understood `PATCH /v1/config` deep-merge (see the
 * gate note in use-supports-inference-profiles.ts); each success refreshes
 * both the config cache and the effective-catalog query so chips and rows
 * agree. Make Default prefers the validated active-profile route - see
 * `makeActive`.
 */
export function useProfileActions(assistantId: string): ProfileActions {
  const configMutation = useLlmConfigPatch(assistantId);
  const queryClient = useQueryClient();

  // Make Default goes through the validated active-profile route on
  // assistants that serve it - the daemon refuses a profile that provably
  // cannot dispatch, so a bad selection errors at the moment of choice
  // instead of on the next chat turn. The route returns a status object, not
  // the config document, so the caches are invalidated rather than written
  // through. Older assistants 404 the route and fall back to the raw PATCH.
  const supportsActiveProfileRoute = useSupportsActiveProfileRoute(assistantId);
  const activeProfileMutation = useInferenceActiveprofilePutMutation({
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: configGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      void queryClient.invalidateQueries({
        queryKey: inferenceProfilesGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
    },
  });

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

  async function makeActive(name: string): Promise<void> {
    if (!supportsActiveProfileRoute) {
      await patchLlm(
        { activeProfile: name },
        MAKE_ACTIVE_ERROR_CONTEXT,
        MAKE_ACTIVE_ERROR_MESSAGE,
      );
      return;
    }
    try {
      await activeProfileMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { name },
      });
    } catch (error) {
      // A 400 is the server's verdict on the selection itself - e.g. a
      // profile whose provider has no connection or key, so it could never
      // dispatch. Show that verbatim and skip the Sentry report: it's a
      // config problem the user can fix, not an app fault.
      const serverMessage = badRequestMessage(error);
      toast.error(serverMessage ?? MAKE_ACTIVE_ERROR_MESSAGE);
      if (!serverMessage) {
        captureError(error, { context: MAKE_ACTIVE_ERROR_CONTEXT });
      }
      throw error;
    }
  }

  return {
    makeActive,
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
    isPending: configMutation.isPending || activeProfileMutation.isPending,
  };
}

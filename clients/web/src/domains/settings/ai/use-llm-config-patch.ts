import { useQueryClient } from "@tanstack/react-query";

import {
  configGetSetQueryData,
  inferenceProfilesGetQueryKey,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";

/**
 * The Language Model card's config mutation: every successful
 * `PATCH /v1/config` writes the merged response back to the shared config
 * cache AND invalidates the effective-profile-catalog query, so the
 * Profiles rows, chips, and pickers all converge on the same state no
 * matter which surface (row kebab, sidepanel, delete flow) issued the
 * write.
 */
export function useLlmConfigPatch(assistantId: string) {
  const queryClient = useQueryClient();
  return useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        data,
      );
      void queryClient.invalidateQueries({
        queryKey: inferenceProfilesGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
    },
  });
}

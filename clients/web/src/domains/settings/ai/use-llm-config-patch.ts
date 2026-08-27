import { useQueryClient } from "@tanstack/react-query";

import {
  configGetSetQueryData,
  configLlmCallsitesGetQueryKey,
  inferenceProfilesGetQueryKey,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";

/**
 * The Language Model card's config mutation: every successful
 * `PATCH /v1/config` writes the merged response back to the shared config
 * cache AND invalidates the two queries whose answers the write can change:
 * the effective profile catalog, and the call-site catalog that reports each
 * site's winning profile. Every surface (row kebab, sidepanel, delete flow,
 * bulk swap) therefore converges on the same state regardless of which one
 * issued the write.
 */
export function useLlmConfigPatch() {
  const queryClient = useQueryClient();
  return useConfigPatchMutation({
    // The assistant id comes from the mutation VARIABLES, not from a
    // render-time prop: TanStack re-binds a pending mutation's options on
    // rerender, so if the active assistant switches while a PATCH is in
    // flight, a captured render-time id would file the old assistant's
    // response under the new assistant's query key.
    onSuccess: (data, variables) => {
      const assistantId = variables.path.assistant_id;
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
      // The call-site catalog reports each site's winning profile, which a
      // write to `llm.callSites` or `llm.profiles` can change. Without this
      // it keeps serving the pre-write winner until its staleTime lapses.
      void queryClient.invalidateQueries({
        queryKey: configLlmCallsitesGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
    },
  });
}

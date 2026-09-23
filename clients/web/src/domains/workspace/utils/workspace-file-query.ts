import { queryOptions } from "@tanstack/react-query";

import { workspaceFileGet } from "@/generated/daemon/sdk.gen";
import type { WorkspaceFileGetResponse } from "@/generated/daemon/types.gen";

/** Query options for workspace file contents and metadata. */
export function workspaceFileRetrieveOptions(opts: {
  path: { assistant_id: string };
  query: { path: string; showHidden?: boolean };
}) {
  return queryOptions<WorkspaceFileGetResponse>({
    queryFn: async () => {
      const { data, error } = await workspaceFileGet({
        path: opts.path,
        query: {
          path: opts.query.path,
          ...(opts.query.showHidden ? { showHidden: "true" } : {}),
        },
      });
      if (error) {
        throw error;
      }
      return data!;
    },
    queryKey: ["assistantsWorkspaceFileRetrieve", opts],
  });
}

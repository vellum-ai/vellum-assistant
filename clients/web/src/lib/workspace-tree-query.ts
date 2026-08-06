import { queryOptions } from "@tanstack/react-query";

import { workspaceTreeGet } from "@/generated/daemon/sdk.gen";
import type { WorkspaceTreeGetResponse } from "@/generated/daemon/types.gen";

/**
 * Cache-key prefix for every workspace directory listing. Mutations that
 * change the tree invalidate this prefix, which reaches all readers.
 */
export const WORKSPACE_TREE_QUERY_KEY = "assistantsWorkspaceTreeRetrieve";

export interface WorkspaceTreeQueryParams {
  assistantId: string;
  /** Workspace-relative directory; empty string lists the workspace root. */
  path?: string;
  showHidden?: boolean;
  includeDirSizes?: boolean;
}

/**
 * Shared React Query options for a workspace directory listing.
 *
 * The workspace browser and chat's file-path links both read directory
 * listings. Routing them through one factory gives them one cache entry per
 * directory when their parameters agree, and — because the key prefix is
 * fixed here — puts every reader behind the browser's post-mutation
 * invalidation, so a file created, renamed, or deleted in the browser is
 * reflected everywhere.
 *
 * Parameters are normalized before they reach the key: callers that omit
 * `showHidden`/`includeDirSizes` and callers that pass their falsy defaults
 * describe the same request and must not land on separate cache entries.
 *
 * Depends only on the generated SDK, so it lives in `lib/` (no domain import).
 */
export function workspaceTreeQueryOptions({
  assistantId,
  path = "",
  showHidden = false,
  includeDirSizes = false,
}: WorkspaceTreeQueryParams) {
  return queryOptions<WorkspaceTreeGetResponse>({
    queryKey: [
      WORKSPACE_TREE_QUERY_KEY,
      assistantId,
      { path, showHidden, includeDirSizes },
    ],
    queryFn: async () => {
      const query: Record<string, string> = {};
      if (path) {
        query.path = path;
      }
      if (showHidden) {
        query.showHidden = "true";
      }
      if (includeDirSizes) {
        query.includeDirSizes = "true";
      }
      const { data, error } = await workspaceTreeGet({
        path: { assistant_id: assistantId },
        query,
      });
      if (error) {
        throw error;
      }
      if (!data) {
        throw new Error("Failed to load workspace tree");
      }
      return data;
    },
  });
}

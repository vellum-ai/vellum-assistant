import { useCallback } from "react";

import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Returns a callback that navigates to the workspace browser with the given
 * workspace-relative file path selected (via the `?file=` deep-link param).
 */
export function useOpenWorkspaceFile(): (path: string) => void {
  const navigate = useNavigate();

  return useCallback(
    (path: string) => {
      void navigate(`${routes.workspace}?file=${encodeURIComponent(path)}`);
    },
    [navigate],
  );
}

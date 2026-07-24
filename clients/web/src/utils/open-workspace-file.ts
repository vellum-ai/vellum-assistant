import { routes } from "@/utils/routes";

/**
 * Navigates to the workspace browser with the given workspace-relative file
 * path selected (via the `?file=` deep-link param).
 *
 * Imports the app router lazily at call time so callers (chat transcript,
 * click handlers) don't pull the full route tree into their static import
 * graph and don't require a Router context at render.
 */
export async function openWorkspaceFile(path: string): Promise<void> {
  const { router } = await import("@/routes");
  await router.navigate(
    `${routes.workspace}?file=${encodeURIComponent(path)}`,
  );
}

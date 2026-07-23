import { routes } from "@/utils/routes";

/** Prefix of `vellum://open/` reference links (workspace-relative path follows). */
export const VELLUM_OPEN_PREFIX = "vellum://open/";

/**
 * Returns true when `href` is a `vellum://open/` reference link — a pointer
 * to a workspace file that opens in the workspace browser, as opposed to a
 * `vellum://workspace|host/` attachment link that downloads.
 */
export function isVellumOpenLink(href: string | undefined): boolean {
  return href != null && href.startsWith(VELLUM_OPEN_PREFIX);
}

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

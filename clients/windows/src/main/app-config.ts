/**
 * Shared application identity constants for the main process.
 *
 * `APP_PROTOCOL` and `APP_HOST` define the custom scheme the packaged
 * renderer is served from; `index.ts` registers it privileged and serves
 * `resources/web-dist` through it, and `main-window.ts` derives the
 * BrowserWindow load URL and the same-origin navigation guard from it.
 *
 * The renderer-base URLs are derived: `RENDERER_BASE_PROD` is the
 * packaged path the `app://` protocol handler resolves to; the dev
 * path is honored from `VELLUM_DEV_URL` (vel's edge proxy, or the
 * local Vite default at port 5173). Both end at the `/assistant`
 * suffix that `clients/web/vite.config.ts`'s `base` setting requires.
 * `VELLUM_LOCAL_RENDERER` opts development into serving the locally built
 * renderer through the app protocol, while keeping platform traffic remote.
 */

export const APP_PROTOCOL = "app";
export const APP_HOST = "vellum.ai";

declare const __VELLUM_BUILD_SHA__: string;
declare const __VELLUM_ENVIRONMENT__: string;

export const WINDOWS_RELEASE_INFO = {
  commitSha:
    typeof __VELLUM_BUILD_SHA__ === "string" ? __VELLUM_BUILD_SHA__ : "unknown",
  releaseChannel:
    typeof __VELLUM_ENVIRONMENT__ === "string"
      ? __VELLUM_ENVIRONMENT__
      : "production",
};

const DEV_SERVER_FALLBACK_URL = "http://localhost:5173/assistant";

/**
 * Renderer-base URL for the packaged app. Auxiliary windows append
 * their own subpath (`/about`, future `/conversations/<id>`, etc.).
 */
export const RENDERER_BASE_PROD = `${APP_PROTOCOL}://${APP_HOST}/assistant`;

/**
 * Renderer-base URL in dev. Honors `VELLUM_DEV_URL` so the launcher
 * can point at whichever Vite-or-equivalent is up (standalone Vite
 * at :5173, or vel's edge proxy at :3000). Strips any trailing slash
 * so callers can append `/<subpath>` without producing `//`.
 */
export const getDevRendererBase = (): string =>
  (process.env.VELLUM_DEV_URL ?? DEV_SERVER_FALLBACK_URL).replace(/\/+$/, "");

/**
 * Renderer-base URL for the current process, for auxiliary windows and
 * any other surface that must land on the same origin as the main window.
 * Follows `usesAppProtocolRenderer`, not `isPackaged` alone: with
 * `VELLUM_LOCAL_RENDERER` the main window is served over `app://` while
 * `VELLUM_DEV_URL` points at the remote platform, and loading that remote
 * URL would hand a window a foreign origin that the IPC sender guard
 * rejects.
 */
export const getRendererBase = (isPackaged: boolean): string =>
  usesAppProtocolRenderer(isPackaged)
    ? RENDERER_BASE_PROD
    : getDevRendererBase();

/** Whether this process loads the renderer through the app protocol. */
export const usesAppProtocolRenderer = (isPackaged: boolean): boolean =>
  isPackaged || process.env.VELLUM_LOCAL_RENDERER === "true";

/**
 * SPA-root URL the main BrowserWindow loads.
 *
 * Dev and prod resolve the root document differently. In dev the renderer
 * is served by Vite, whose dev server only serves the app when the request
 * path matches its configured `base` (`/assistant/`) exactly - a slashless
 * `/assistant` returns Vite's "did you mean `/assistant/`?" helper page
 * instead of the SPA. So the dev root carries the trailing slash. In prod
 * the `app://` protocol handler maps the slashless `/assistant` to
 * `index.html`, so `RENDERER_BASE_PROD` loads as-is (a trailing slash would
 * land on the `/assistant/*` NotFound route).
 */
export const getRendererRootUrl = (isPackaged: boolean): string =>
  usesAppProtocolRenderer(isPackaged)
    ? RENDERER_BASE_PROD
    : `${getDevRendererBase()}/`;

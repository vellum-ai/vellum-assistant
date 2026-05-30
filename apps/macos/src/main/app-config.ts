/**
 * Shared application identity constants for the main process.
 *
 * `app-protocol` and `app-host` define the custom scheme the packaged
 * renderer is served from. They're referenced from at least three
 * places today (`index.ts` for `protocol.registerSchemesAsPrivileged`
 * + the `protocol.handle` registration, `main-window.ts` for the
 * BrowserWindow load URL and the same-origin navigation guard,
 * `about.ts` for the About window's prod URL), so they live here as a
 * single source of truth. Drift between callers would have shown up
 * as a broken renderer load rather than a build error, which is
 * exactly the kind of thing a small shared module prevents.
 *
 * The renderer-base URLs are derived: `RENDERER_BASE_PROD` is the
 * packaged path the `app://` protocol handler resolves to; the dev
 * path is honored from `VELLUM_DEV_URL` (vel's edge proxy, or the
 * local Vite default at port 5173). Both end at the `/assistant`
 * suffix that `apps/web/vite.config.ts`'s `base` setting requires.
 */

export const APP_PROTOCOL = "app";
export const APP_HOST = "vellum.ai";

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

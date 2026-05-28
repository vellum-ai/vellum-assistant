/**
 * Single source of truth for the dev-mode Vite renderer server location.
 *
 * `scripts/dev.ts` spawns `apps/web`'s Vite dev server and `src/main/index.ts`
 * loads the resulting URL in a BrowserWindow. They must agree on the port,
 * and they must override `apps/web`'s default — its `vite.config.ts` reads
 * `server.port` from `env.PORT` (default `3000`) with `strictPort: true`,
 * so without an explicit override the spawned server lands on `3000` while
 * the BrowserWindow keeps trying `5173`.
 *
 * Exporting both the port and the assembled URL lets callers pick what
 * they need without re-concatenating strings.
 */
export const DEV_SERVER_PORT = "5173" as const;
export const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

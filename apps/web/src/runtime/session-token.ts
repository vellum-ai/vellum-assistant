import { isElectron } from "@/runtime/is-electron";

// Seeded once per page load from the main process, which owns the token.
// Auth transitions hard-navigate, reloading the renderer and re-seeding,
// so a per-load cache stays correct without per-request IPC. `undefined` =
// not yet seeded; `null` = signed out. Login acquiring a token mid-page is
// the one exception, handled by `primeElectronSessionToken`.
let cached: string | null | undefined;

/** The session token in Electron, or `null` on web / when signed out. */
export function getElectronSessionToken(): string | null {
  if (!isElectron()) return null;
  if (cached === undefined) {
    cached = window.vellum?.auth?.getSessionToken?.() ?? null;
  }
  return cached;
}

/** Update the cache when login acquires a token mid-page, before the post-login navigation. */
export function primeElectronSessionToken(token: string): void {
  cached = token;
}

export function __resetForTesting(): void {
  cached = undefined;
}

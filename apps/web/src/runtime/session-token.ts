import { isElectron } from "@/runtime/is-electron";

// Seeded once per page load from the main process, which owns the token.
// Auth transitions (login / logout / re-auth) hard-navigate, reloading the
// renderer and re-seeding, so a per-load cache stays correct without any
// per-request IPC. `undefined` = not yet seeded; `null` = signed out.
let cached: string | null | undefined;

/** The session token in Electron, or `null` on web / when signed out. */
export function getElectronSessionToken(): string | null {
  if (!isElectron()) return null;
  if (cached === undefined) {
    cached = window.vellum?.auth?.getSessionToken?.() ?? null;
  }
  return cached;
}

export function __resetForTesting(): void {
  cached = undefined;
}

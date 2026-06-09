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
    if (!cached) {
      cached = consumeStashedSessionToken();
    }
  }
  return cached;
}

const SESSION_TOKEN_STORAGE_KEY = "vellum:electron:sessionToken";

/**
 * Stash the session token in `sessionStorage` so it survives the hard
 * navigation that follows a successful OAuth exchange. On the next page
 * load, {@link getElectronSessionToken} picks it up as a fallback when
 * `safeStorage` failed to persist the token to disk.
 */
export function stashSessionTokenForNavigation(token: string): void {
  try {
    sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
  } catch {
    // sessionStorage unavailable or full — the IPC fallback still works
    // when safeStorage persisted correctly.
  }
}

function consumeStashedSessionToken(): string | null {
  try {
    const token = sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
    if (token) sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    return token;
  } catch {
    return null;
  }
}

export function __resetForTesting(): void {
  cached = undefined;
}

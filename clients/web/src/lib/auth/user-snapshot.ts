/**
 * Last-known authenticated platform user, persisted so an offline boot
 * can restore the session optimistically instead of bouncing a
 * still-logged-in user to the login screen (LUM-2412).
 *
 * The key uses the `vellum:` user-scoped prefix, so logout's
 * `clearUserScopedStorage` sweep (and the cross-tab logout broadcast)
 * removes it automatically; the auth store also clears it explicitly
 * whenever a session check comes back with a settled "no session"
 * answer, so a revoked session can't be resurrected by a later
 * offline boot.
 */
import type { AuthUser } from "@/stores/auth-store";

const SNAPSHOT_KEY = "vellum:auth:userSnapshot";

export function persistUserSnapshot(user: AuthUser | null): void {
  if (!user) return;
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(user));
  } catch {
    // Storage unavailable — offline restore just won't have a snapshot.
  }
}

export function readUserSnapshot(): AuthUser | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthUser> | null;
    if (!parsed || typeof parsed !== "object") return null;
    // Field-by-field coercion so a malformed or stale-schema snapshot
    // degrades to safe defaults instead of poisoning the auth state.
    return {
      // Only platform users are ever snapshotted, so default `kind` here rather
      // than reading it — old snapshots without the field still restore cleanly.
      kind: "platform",
      id: typeof parsed.id === "string" ? parsed.id : null,
      username: typeof parsed.username === "string" ? parsed.username : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
      isStaff: parsed.isStaff === true,
      firstName: typeof parsed.firstName === "string" ? parsed.firstName : "",
      lastName: typeof parsed.lastName === "string" ? parsed.lastName : "",
    };
  } catch {
    return null;
  }
}

export function clearUserSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // Storage unavailable.
  }
}

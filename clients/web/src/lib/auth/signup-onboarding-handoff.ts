/**
 * First name collected on provider signup, handed to research onboarding.
 *
 * The account domain cannot import onboarding, so both sides use this
 * session-scoped stash. `sessionStorage` is cleared on logout.
 */

const STORAGE_KEY = "signup.onboarding.firstName";

function getSessionStorage(): Storage | null {
  try {
    const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

export function setSignupOnboardingFirstName(firstName: string): void {
  const trimmed = firstName.trim();
  const storage = getSessionStorage();
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(STORAGE_KEY);
    if (trimmed) {
      storage.setItem(STORAGE_KEY, trimmed);
    }
  } catch {
    // Storage unavailable / quota exceeded. Onboarding falls back to the
    // session user, which is empty when the provider omitted a name.
  }
}

export function peekSignupOnboardingFirstName(): string | null {
  const storage = getSessionStorage();
  if (storage === null) {
    return null;
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const trimmed = raw?.trim() ?? "";
    return trimmed || null;
  } catch {
    return null;
  }
}

export function takeSignupOnboardingFirstName(): string | null {
  const value = peekSignupOnboardingFirstName();
  const storage = getSessionStorage();
  if (storage !== null) {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Best-effort.
    }
  }
  return value;
}

/** Signup-typed name wins; otherwise the session user name. */
export function resolveOnboardingFirstName(
  sessionFirstName: string | undefined | null,
): string {
  return peekSignupOnboardingFirstName() || sessionFirstName?.trim() || "";
}

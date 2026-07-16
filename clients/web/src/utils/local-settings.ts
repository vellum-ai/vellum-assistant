// All three helpers swallow `localStorage` exceptions. Reads/writes can
// throw in private browsing, on quota exhaustion, or when storage is
// disabled by policy. Every caller in this repo treats settings
// persistence as best-effort — none are gated on the write succeeding —
// so failing soft keeps the onboarding / retire / settings flows
// navigable when storage is unavailable.

export function getLocalSetting(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setLocalSetting(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
  notifyChange(key, value);
}

export function removeLocalSetting(key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    return;
  }
  notifyChange(key, null);
}

// ---------------------------------------------------------------------------
// Typed helpers — boolean and number
// ---------------------------------------------------------------------------

export function getLocalBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

export function setLocalBool(key: string, value: boolean): void {
  setLocalSetting(key, value ? "true" : "false");
}

/**
 * Tri-state boolean read: `true`/`false` for an explicitly stored value,
 * `null` when the key is absent or unreadable. Lets callers distinguish
 * "never chosen" from an explicit choice.
 */
export function getLocalBoolOrNull(key: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    return null;
  }
}

export function getLocalNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function setLocalNumber(key: string, value: number): void {
  setLocalSetting(key, String(value));
}

// ---------------------------------------------------------------------------
// Change watcher — listens for both cross-tab (storage) and same-tab
// (vellum:pref-changed) events for a specific key.
// ---------------------------------------------------------------------------

interface PrefChangedDetail {
  key: string;
  value: string | null;
}

export function watchSetting(
  key: string,
  callback: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === key) callback();
  };
  const onPrefChanged = (event: Event) => {
    const detail = (event as CustomEvent<PrefChangedDetail>).detail;
    if (detail?.key === key) callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(PREF_CHANGED_EVENT, onPrefChanged);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(PREF_CHANGED_EVENT, onPrefChanged);
  };
}

// ---------------------------------------------------------------------------
// Same-tab notification
// ---------------------------------------------------------------------------

const PREF_CHANGED_EVENT = "vellum:pref-changed";

// `localStorage.setItem` fires the native `storage` event in *other* tabs
// only. Same-tab observers (e.g. the Sentry gate that toggles crash
// reporting when the user flips Share Diagnostics on `/onboarding/privacy`
// or `/settings/privacy`) need a synthetic signal. A single custom event
// covers every key; listeners filter on `detail.key`.
function notifyChange(key: string, value: string | null): void {
  try {
    window.dispatchEvent(
      new CustomEvent(PREF_CHANGED_EVENT, { detail: { key, value } }),
    );
  } catch {
    // CustomEvent construction shouldn't fail; swallow defensively so a
    // broken environment can't strand callers that expect this to be a
    // fire-and-forget side effect.
  }
}

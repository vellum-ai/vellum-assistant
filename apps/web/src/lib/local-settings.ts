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

// `localStorage.setItem` fires the native `storage` event in *other* tabs
// only. Same-tab observers (e.g. the Sentry gate that toggles crash
// reporting when the user flips Share Diagnostics on `/onboarding/privacy`
// or `/settings/privacy`) need a synthetic signal. A single custom event
// covers every key; listeners filter on `detail.key`.
function notifyChange(key: string, value: string | null): void {
  try {
    window.dispatchEvent(
      new CustomEvent("vellum:pref-changed", { detail: { key, value } }),
    );
  } catch {
    // CustomEvent construction shouldn't fail; swallow defensively so a
    // broken environment can't strand callers that expect this to be a
    // fire-and-forget side effect.
  }
}

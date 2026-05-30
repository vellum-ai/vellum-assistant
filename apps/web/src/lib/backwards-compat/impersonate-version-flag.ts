// Dev flag: override the assistant's reported version so every
// version-gated code path in the web client behaves as if it were
// talking to that assistant build.
//
// Lives alongside `pickConversationIdWireField`,
// `supportsServerMintedConversation`, `useAssistantSupports`, etc. so
// the override and the gates it influences are co-located.
//
// Mechanism: `setImpersonatedAssistantVersion(...)` writes to
// localStorage and reloads. On the next page load, the assistant
// identity store's `setIdentity` action reads this flag and substitutes
// the impersonated version on every write — initial fetch, SSE
// `identity_changed`, and the optimistic onboarding seed all funnel
// through `setIdentity`, so the override is uniformly applied without
// any consumer needing to know about it.
//
// Reload-on-change rationale:
//   • some consumers cache version-derived constants at module load
//     (e.g. anything that wants a stable identity across re-renders);
//   • SSE handlers re-read from the store on every event but a stale
//     in-memory copy of `version` on a long-lived listener would
//     surprise a developer mid-session.
// Reloading guarantees a uniform world after the flag flips.
//
// Surface (exposed under `window._vellumDebug.flags`):
//
//   impersonateVersion("0.8.6")  — set + reload
//   impersonateVersion(null)     — clear + reload
//   impersonateVersion()         — log + return current value, no reload

import { getLocalSetting, setLocalSetting, removeLocalSetting } from "@/utils/local-settings";

const STORAGE_KEY = "vellum:debug:impersonateAssistantVersion";

/**
 * Read the impersonated version synchronously. Safe to call at any
 * time, including from inside the assistant identity store's
 * `setIdentity` action (which is the primary consumer).
 *
 * Returns `null` when no override is set, the storage key is missing,
 * or localStorage access throws (private browsing / sandboxed iframes).
 */
export function getImpersonatedAssistantVersion(): string | null {
  const raw = getLocalSetting(STORAGE_KEY, "");
  return raw.length > 0 ? raw : null;
}

/**
 * Set or clear the impersonated assistant version.
 *
 * - `value: string` (non-empty) — persist and reload so all version
 *   gates re-evaluate against the impersonated value.
 * - `value: null` — clear the override and reload back to the real
 *   assistant-reported version.
 * - `value: undefined` — inspect-only. Log + return the current
 *   value. No mutation, no reload.
 *
 * Returns the value that will be in effect after the call (post-reload
 * for set/clear, current for inspect). Note the reload kills the JS
 * context, so callers rarely consume the return value on set/clear
 * paths — it's documented mainly for tests.
 */
export function setImpersonatedAssistantVersion(
  value?: string | null,
): string | null {
  if (typeof window === "undefined") return null;

  // Inspect-only branch — explicitly no-op, no reload.
  if (value === undefined) {
    const current = getImpersonatedAssistantVersion();
    console.info(
      `[vellumDebug] impersonateAssistantVersion (current) = ${
        current === null ? "null" : JSON.stringify(current)
      }`,
    );
    return current;
  }

  if (value === null || value === "") {
    removeLocalSetting(STORAGE_KEY);
    if (getImpersonatedAssistantVersion() !== null) {
      console.warn(
        "[vellumDebug] failed to clear impersonateAssistantVersion flag",
      );
      return getImpersonatedAssistantVersion();
    }
    console.info(
      "[vellumDebug] impersonateAssistantVersion = null (cleared) — reloading…",
    );
  } else {
    setLocalSetting(STORAGE_KEY, value);
    if (getImpersonatedAssistantVersion() !== value) {
      console.warn(
        "[vellumDebug] failed to persist impersonateAssistantVersion flag",
      );
      return getImpersonatedAssistantVersion();
    }
    console.info(
      `[vellumDebug] impersonateAssistantVersion = ${JSON.stringify(
        value,
      )} — reloading…`,
    );
  }
  window.location.reload();
  return value === "" ? null : value;
}

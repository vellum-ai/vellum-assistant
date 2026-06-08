/**
 * Debug-flag snapshot for the feedback tar.
 *
 * The client's debug flags are localStorage overrides under the
 * `vellum:debug:*` namespace with no server targeting, so the only record
 * of which ones were set when a report was filed is the client that filed
 * it. Without capturing them at submission time, flag state has to be
 * inferred from behavior in the diagnostics, which is ambiguous because the
 * resolved value never reaches the export.
 *
 * Two complementary views are captured so analysis is unambiguous:
 *   - `resolved`: the effective value each flag's accessor returns, so the
 *     code-level default is reflected even when no override is stored.
 *   - `overrides`: every raw `vellum:debug:*` localStorage entry, scanned
 *     generically so future debug flags appear in the export without any
 *     change here.
 */

import { getImpersonatedAssistantVersion } from "@/lib/backwards-compat/impersonate-version-flag";

const DEBUG_PREFIX = "vellum:debug:";

export interface DebugFlagSnapshot {
  collectedAt: string;
  /**
   * Effective values driving client behavior, resolved through each flag's
   * accessor. These reflect the code-level default when no override is set,
   * which raw localStorage entries alone cannot convey.
   */
  resolved: {
    impersonateAssistantVersion: string | null;
  };
  /**
   * Raw `vellum:debug:*` localStorage entries, verbatim. Keyed by the full
   * storage key so the namespace is self-documenting in the export.
   */
  overrides: Record<string, string>;
}

function scanDebugOverrides(): Record<string, string> {
  const overrides: Record<string, string> = {};
  if (typeof window === "undefined") return overrides;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key === null || !key.startsWith(DEBUG_PREFIX)) continue;
      const value = window.localStorage.getItem(key);
      if (value !== null) overrides[key] = value;
    }
  } catch {
    // localStorage can throw in private browsing, sandboxed iframes, or when
    // disabled by policy. Diagnostics are best-effort — degrade to whatever
    // was readable rather than failing the feedback submission.
  }
  return overrides;
}

/** Build a snapshot of the client's debug-flag state for support exports. */
export function buildDebugFlagSnapshot(): DebugFlagSnapshot {
  return {
    collectedAt: new Date().toISOString(),
    resolved: {
      impersonateAssistantVersion: getImpersonatedAssistantVersion(),
    },
    overrides: scanDebugOverrides(),
  };
}

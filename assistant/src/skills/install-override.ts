// ─── Types ──────────────────────────────────────────────────────────────────────

export interface InstallOverride {
  skillId: string;
  source: string;
  overriddenAt: string;
  overallRiskAtOverride: string;
  recommendation: string;
}

export interface OverrideTracker {
  /** Record that a user explicitly overrode a security recommendation. */
  recordOverride(override: InstallOverride): void;
  /** Check if a user has previously overridden for this skill from this source. */
  hasOverride(skillId: string, source: string): boolean;
  /** Get all recorded overrides. */
  getOverrides(): InstallOverride[];
}

// ─── In-memory implementation ───────────────────────────────────────────────────

/**
 * Session-scoped override tracker. Records are kept in memory for the
 * duration of the process -- no persistence yet. The interface is designed
 * so a persistent backend can be swapped in later without changing callers.
 */
export function createOverrideTracker(): OverrideTracker {
  const overrides: InstallOverride[] = [];

  function overrideKey(skillId: string, source: string): string {
    return `${source}/${skillId}`;
  }

  const seen = new Set<string>();

  return {
    recordOverride(override: InstallOverride): void {
      const key = overrideKey(override.skillId, override.source);
      // Allow re-recording (e.g. risk level changed), but keep the full audit trail.
      // Clone so later mutations to the caller's object don't rewrite history.
      overrides.push({ ...override });
      seen.add(key);
    },

    hasOverride(skillId: string, source: string): boolean {
      return seen.has(overrideKey(skillId, source));
    },

    getOverrides(): InstallOverride[] {
      return overrides.map((o) => ({ ...o }));
    },
  };
}
